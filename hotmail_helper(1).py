#!/usr/bin/env python3
"""Local Outlook/Hotmail mail API compatible with outlook-helper and this repo.

Implemented endpoints:
  - GET/POST /api/mail-new
  - GET/POST /api/mail-all
  - POST     /api/process-inbox
  - POST     /api/process-junk
  - POST     /messages
  - GET      /health and /api/health

The /api/* request and response shape follows HChaoHui/msOauth2api, which is
what linqiu919/outlook-helper calls through its OutlookService.
"""

from __future__ import annotations

import base64
import email
import imaplib
import json
import logging
import os
import re
import ssl
import sys
import time
import traceback
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parsedate_to_datetime
from typing import Any

import requests
import urllib3
from flask import Flask, Response, jsonify, request

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


APP = Flask(__name__)

PORT = int(os.environ.get("HOTMAIL_HELPER_PORT", "17373"))
HOST = os.environ.get("HOTMAIL_HELPER_HOST", "127.0.0.1")
PASSWORD = os.environ.get("HOTMAIL_HELPER_PASSWORD", "")
HTTP_PROXY = os.environ.get("HOTMAIL_HELPER_PROXY", "")
DEFAULT_TOP = int(os.environ.get("HOTMAIL_HELPER_TOP", "10"))
MAX_TOP = int(os.environ.get("HOTMAIL_HELPER_MAX_TOP", "100"))
ENABLE_DELETE = os.environ.get("HOTMAIL_HELPER_ENABLE_DELETE", "").lower() in {
    "1",
    "true",
    "yes",
}

MS_CONSUMERS_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
MS_COMMON_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"
IMAP_HOST = "outlook.office365.com"
IMAP_PORT = 993

LOG_LEVEL = os.environ.get("HOTMAIL_HELPER_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
LOGGER = logging.getLogger("hotmail-local-api")


class HelperError(Exception):
    """Error with an HTTP status code and user-safe message."""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


def http_session() -> requests.Session:
    session = requests.Session()
    session.verify = False
    if HTTP_PROXY:
        session.proxies = {"http": HTTP_PROXY, "https": HTTP_PROXY}
    return session


def params_from_request() -> dict[str, Any]:
    if request.method == "GET":
        return dict(request.args)
    payload = request.get_json(force=True, silent=True)
    if isinstance(payload, dict):
        return payload
    return {}


def first_present(params: dict[str, Any], *names: str, default: str = "") -> str:
    for name in names:
        value = params.get(name)
        if value is not None:
            return str(value).strip()
    return default


def require_password(params: dict[str, Any]) -> None:
    if not PASSWORD:
        return
    supplied = first_present(params, "password")
    if supplied != PASSWORD:
        raise HelperError("Authentication failed", 401)


def require_credentials(params: dict[str, Any], include_mailbox: bool) -> dict[str, str]:
    require_password(params)
    credentials = {
        "refresh_token": first_present(params, "refresh_token", "refreshToken"),
        "client_id": first_present(params, "client_id", "clientId"),
        "email": first_present(params, "email"),
        "mailbox": normalize_mailbox(first_present(params, "mailbox", default="INBOX")),
    }
    missing = [
        key
        for key in ("refresh_token", "client_id", "email")
        if not credentials[key]
    ]
    if include_mailbox and not credentials["mailbox"]:
        missing.append("mailbox")
    if missing:
        raise HelperError(f"Missing required parameters: {', '.join(missing)}", 400)
    return credentials


def parse_top(params: dict[str, Any], default: int = DEFAULT_TOP) -> int:
    raw = first_present(params, "top", "limit", default=str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    return max(1, min(value, MAX_TOP))


def normalize_mailbox(mailbox: str) -> str:
    value = (mailbox or "INBOX").strip()
    lower = value.lower()
    if lower in {"inbox", "收件箱"}:
        return "INBOX"
    if lower in {"junk", "junkemail", "junk email", "spam", "垃圾邮件"}:
        return "Junk"
    return value or "INBOX"


def graph_mailbox_id(mailbox: str) -> str:
    return "junkemail" if "junk" in mailbox.lower() else "inbox"


def imap_mailbox_candidates(mailbox: str) -> list[str]:
    if "junk" in mailbox.lower():
        return ["Junk", "Junk Email", "junkemail"]
    return ["INBOX", "Inbox", "inbox"]


def exchange_token(
    refresh_token: str,
    client_id: str,
    *,
    scope: str | None = None,
    token_url: str = MS_CONSUMERS_TOKEN_URL,
) -> dict[str, Any]:
    body = {
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }
    if scope:
        body["scope"] = scope

    resp = http_session().post(
        token_url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    if resp.status_code != 200:
        raise HelperError(f"Token exchange failed HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise HelperError(f"Token exchange returned non-JSON: {exc}") from exc
    if not data.get("access_token"):
        raise HelperError(f"Token exchange returned no access_token: {str(data)[:300]}")
    return data


def get_graph_token(refresh_token: str, client_id: str) -> tuple[str | None, str | None, str]:
    errors: list[str] = []
    strategies = [
        ("consumers-default", MS_CONSUMERS_TOKEN_URL, "https://graph.microsoft.com/.default"),
        (
            "consumers-mail-read",
            MS_CONSUMERS_TOKEN_URL,
            "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
        ),
        ("common-default", MS_COMMON_TOKEN_URL, "https://graph.microsoft.com/.default"),
        (
            "common-mail-read",
            MS_COMMON_TOKEN_URL,
            "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
        ),
    ]
    for name, token_url, scope in strategies:
        try:
            data = exchange_token(refresh_token, client_id, scope=scope, token_url=token_url)
            token_scope = str(data.get("scope") or "")
            access_token = str(data["access_token"])
            next_refresh = str(data.get("refresh_token") or refresh_token)
            if "Mail.Read" in token_scope or name.endswith("mail-read"):
                return access_token, next_refresh, name
            errors.append(f"{name}: token lacks Mail.Read scope ({token_scope[:120]})")
        except Exception as exc:
            errors.append(f"{name}: {exc}")
    LOGGER.info("Graph token unavailable: %s", "; ".join(errors))
    return None, None, "; ".join(errors)


def get_imap_token(refresh_token: str, client_id: str) -> tuple[str, str]:
    data = exchange_token(refresh_token, client_id, token_url=MS_CONSUMERS_TOKEN_URL)
    return str(data["access_token"]), str(data.get("refresh_token") or refresh_token)


def decode_mime_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def safe_message_date(value: str | None) -> str:
    if not value:
        return ""
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return value


def message_timestamp(mail: dict[str, Any]) -> float:
    value = str(mail.get("receivedDateTime") or mail.get("date") or "")
    if not value:
        return 0.0
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return 0.0


def message_part_to_text(part: Message) -> str:
    try:
        payload = part.get_payload(decode=True)
        if payload is None:
            return ""
        charset = part.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")
    except Exception:
        return ""


def extract_bodies(msg: Message) -> tuple[str, str]:
    plain_parts: list[str] = []
    html_parts: list[str] = []
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        content_type = part.get_content_type()
        disposition = str(part.get("Content-Disposition") or "").lower()
        if "attachment" in disposition:
            continue
        if content_type == "text/plain":
            plain_parts.append(message_part_to_text(part))
        elif content_type == "text/html":
            html_parts.append(message_part_to_text(part))
    return "\n".join(p for p in plain_parts if p), "\n".join(p for p in html_parts if p)


def imap_connect(email_address: str, access_token: str) -> imaplib.IMAP4_SSL:
    context = ssl.create_default_context()
    client = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=context)
    auth = f"user={email_address}\x01auth=Bearer {access_token}\x01\x01"
    client.authenticate("XOAUTH2", lambda _: auth.encode("utf-8"))
    return client


def imap_select(client: imaplib.IMAP4_SSL, mailbox: str, readonly: bool) -> str:
    errors: list[str] = []
    for candidate in imap_mailbox_candidates(mailbox):
        status, _ = client.select(f'"{candidate}"', readonly=readonly)
        if status == "OK":
            return candidate
        errors.append(candidate)
    raise HelperError(f"IMAP mailbox not available: {mailbox} (tried {', '.join(errors)})")


def parse_imap_message(raw_bytes: bytes, seq: bytes) -> dict[str, Any]:
    msg = email.message_from_bytes(raw_bytes)
    text, html = extract_bodies(msg)
    from_header = decode_mime_header(msg.get("From"))
    subject = decode_mime_header(msg.get("Subject"))
    to_header = decode_mime_header(msg.get("To"))
    date_value = safe_message_date(msg.get("Date"))
    body_preview = text or strip_html(html)
    return {
        "id": str(seq.decode(errors="ignore") if isinstance(seq, bytes) else seq),
        "send": from_header,
        "from_email": extract_email_address(from_header),
        "to": to_header,
        "subject": subject,
        "text": text or body_preview,
        "html": html,
        "date": date_value,
        "receivedDateTime": date_value,
        "bodyPreview": body_preview[:1000],
        "isRead": False,
    }


def fetch_imap_messages(
    email_address: str,
    access_token: str,
    mailbox: str,
    *,
    top: int,
) -> list[dict[str, Any]]:
    client = imap_connect(email_address, access_token)
    try:
        opened = imap_select(client, mailbox, readonly=True)
        status, payload = client.search(None, "ALL")
        if status != "OK" or not payload:
            return []
        message_ids = payload[0].split()
        if not message_ids:
            return []
        latest_ids = message_ids[-top:]
        results: list[dict[str, Any]] = []
        for seq in reversed(latest_ids):
            status, fetched = client.fetch(seq, "(RFC822)")
            if status != "OK":
                LOGGER.warning("IMAP fetch failed for %s/%s", opened, seq)
                continue
            raw = None
            for item in fetched:
                if isinstance(item, tuple):
                    raw = item[1]
                    break
            if raw:
                results.append(parse_imap_message(raw, seq))
        return sorted(results, key=message_timestamp, reverse=True)
    finally:
        try:
            client.close()
        except Exception:
            pass
        try:
            client.logout()
        except Exception:
            pass


def strip_html(value: str) -> str:
    text = re.sub(r"<(script|style).*?>.*?</\1>", " ", value or "", flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_email_address(value: str) -> str:
    match = re.search(r"[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[A-Za-z]{2,}", value or "")
    return match.group(0) if match else value


def graph_headers(access_token: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
        'Prefer': 'outlook.body-content-type="html"',
    }


def fetch_graph_messages(access_token: str, mailbox: str, *, top: int) -> list[dict[str, Any]]:
    url = f"{GRAPH_BASE}/me/mailFolders/{graph_mailbox_id(mailbox)}/messages"
    params = {
        "$top": str(top),
        "$orderby": "receivedDateTime desc",
        "$select": ",".join(
            [
                "id",
                "internetMessageId",
                "subject",
                "from",
                "toRecipients",
                "bodyPreview",
                "body",
                "receivedDateTime",
                "createdDateTime",
                "isRead",
            ]
        ),
    }
    resp = http_session().get(url, params=params, headers=graph_headers(access_token), timeout=30)
    if resp.status_code != 200:
        raise HelperError(f"Graph mail fetch failed HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    return [mail_api_from_graph(item) for item in data.get("value", []) if isinstance(item, dict)]


def mail_api_from_graph(item: dict[str, Any]) -> dict[str, Any]:
    from_obj = item.get("from") if isinstance(item.get("from"), dict) else {}
    from_email = ""
    if isinstance(from_obj.get("emailAddress"), dict):
        from_email = str(from_obj["emailAddress"].get("address") or "")

    to_recipients = item.get("toRecipients") if isinstance(item.get("toRecipients"), list) else []
    to_values: list[str] = []
    for recipient in to_recipients:
        if not isinstance(recipient, dict):
            continue
        email_obj = recipient.get("emailAddress")
        if isinstance(email_obj, dict) and email_obj.get("address"):
            to_values.append(str(email_obj["address"]))

    body_obj = item.get("body") if isinstance(item.get("body"), dict) else {}
    html_body = str(body_obj.get("content") or "")
    preview = str(item.get("bodyPreview") or "")
    received = str(item.get("receivedDateTime") or item.get("createdDateTime") or "")
    return {
        "id": str(item.get("id") or item.get("internetMessageId") or ""),
        "send": from_email,
        "from_email": from_email,
        "to": ", ".join(to_values),
        "subject": str(item.get("subject") or ""),
        "text": preview,
        "html": html_body,
        "date": received,
        "receivedDateTime": received,
        "bodyPreview": preview,
        "isRead": bool(item.get("isRead")),
    }


def graph_shape(mail: dict[str, Any]) -> dict[str, Any]:
    sender = str(mail.get("from_email") or extract_email_address(str(mail.get("send") or "")))
    html = str(mail.get("html") or "")
    text = str(mail.get("text") or mail.get("bodyPreview") or strip_html(html))
    date_value = str(mail.get("receivedDateTime") or mail.get("date") or "")
    return {
        "id": str(mail.get("id") or ""),
        "subject": str(mail.get("subject") or ""),
        "from": {"emailAddress": {"address": sender}},
        "toRecipients": [
            {"emailAddress": {"address": item.strip()}}
            for item in str(mail.get("to") or "").split(",")
            if item.strip()
        ],
        "bodyPreview": str(mail.get("bodyPreview") or text)[:1000],
        "body": {"contentType": "html" if html else "text", "content": html or text},
        "receivedDateTime": date_value,
        "createdDateTime": date_value,
        "isRead": bool(mail.get("isRead")),
        "internetMessageId": str(mail.get("id") or ""),
        "text": text,
    }


def fetch_messages(
    *,
    refresh_token: str,
    client_id: str,
    email_address: str,
    mailbox: str,
    top: int,
) -> tuple[list[dict[str, Any]], str, str]:
    graph_token, next_refresh, graph_source = get_graph_token(refresh_token, client_id)
    if graph_token:
        LOGGER.info("Fetching %s via Graph (%s), top=%s", mailbox, graph_source, top)
        messages = fetch_graph_messages(graph_token, mailbox, top=top)
        return messages, next_refresh or refresh_token, "graph"

    LOGGER.info("Fetching %s via IMAP XOAUTH2, top=%s", mailbox, top)
    imap_token, imap_refresh = get_imap_token(next_refresh or refresh_token, client_id)
    messages = fetch_imap_messages(email_address, imap_token, mailbox, top=top)
    return messages, imap_refresh, "imap"


def html_response(mail: dict[str, Any]) -> str:
    safe = {
        "send": str(mail.get("send") or ""),
        "subject": str(mail.get("subject") or ""),
        "date": str(mail.get("date") or ""),
        "text": str(mail.get("text") or mail.get("bodyPreview") or ""),
    }
    body = safe["text"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"""<!doctype html>
<html>
<head><meta charset="utf-8"><title>{safe["subject"]}</title></head>
<body>
<h1>邮件信息</h1>
<p><strong>发件人:</strong> {safe["send"]}</p>
<p><strong>主题:</strong> {safe["subject"]}</p>
<p><strong>日期:</strong> {safe["date"]}</p>
<pre>{body}</pre>
</body>
</html>"""


def api_mail_all() -> Response:
    params = params_from_request()
    credentials = require_credentials(params, include_mailbox=True)
    top = parse_top(params, default=MAX_TOP)
    messages, _, source = fetch_messages(
        refresh_token=credentials["refresh_token"],
        client_id=credentials["client_id"],
        email_address=credentials["email"],
        mailbox=credentials["mailbox"],
        top=top,
    )
    LOGGER.info(
        "%s /api/mail-all email=%s mailbox=%s count=%s",
        source,
        credentials["email"],
        credentials["mailbox"],
        len(messages),
    )
    return jsonify(messages)


def api_mail_new() -> Response:
    params = params_from_request()
    credentials = require_credentials(params, include_mailbox=True)
    top = parse_top(params, default=1)
    response_type = first_present(params, "response_type", default="json").lower()
    messages, _, source = fetch_messages(
        refresh_token=credentials["refresh_token"],
        client_id=credentials["client_id"],
        email_address=credentials["email"],
        mailbox=credentials["mailbox"],
        top=top,
    )
    LOGGER.info(
        "%s /api/mail-new email=%s mailbox=%s count=%s",
        source,
        credentials["email"],
        credentials["mailbox"],
        len(messages),
    )
    if not messages:
        return jsonify([])
    if response_type == "html":
        return Response(html_response(messages[0]), mimetype="text/html")
    if response_type != "json":
        raise HelperError('Invalid response_type. Use "json" or "html".', 400)
    return jsonify(messages[0] if top <= 1 else messages)


def process_mailbox(mailbox: str) -> Response:
    if not ENABLE_DELETE:
        return jsonify(
            {
                "error": "Deleting mail is disabled. Set HOTMAIL_HELPER_ENABLE_DELETE=1 to enable it.",
                "mailbox": mailbox,
            }
        ), 403

    params = params_from_request()
    credentials = require_credentials(params, include_mailbox=False)
    imap_token, _ = get_imap_token(credentials["refresh_token"], credentials["client_id"])
    client = imap_connect(credentials["email"], imap_token)
    deleted = 0
    try:
        imap_select(client, mailbox, readonly=False)
        status, payload = client.search(None, "ALL")
        if status == "OK" and payload and payload[0]:
            ids = payload[0].split()
            for seq in ids:
                client.store(seq, "+FLAGS", "\\Deleted")
            client.expunge()
            deleted = len(ids)
    finally:
        try:
            client.close()
        except Exception:
            pass
        try:
            client.logout()
        except Exception:
            pass
    return jsonify({"message": "Emails processed successfully.", "deleted": deleted, "mailbox": mailbox})


@APP.route("/api/mail-new", methods=["GET", "POST"])
def handle_mail_new() -> Response:
    return safe_json(api_mail_new)


@APP.route("/api/mail-all", methods=["GET", "POST"])
def handle_mail_all() -> Response:
    return safe_json(api_mail_all)


@APP.route("/api/process-inbox", methods=["GET", "POST"])
def handle_process_inbox() -> Response:
    return safe_json(lambda: process_mailbox("INBOX"))


@APP.route("/api/process-junk", methods=["GET", "POST"])
def handle_process_junk() -> Response:
    return safe_json(lambda: process_mailbox("Junk"))


@APP.route("/messages", methods=["POST"])
def handle_messages() -> Response:
    def run() -> Response:
        params = params_from_request()
        credentials = require_credentials(params, include_mailbox=False)
        mailboxes = params.get("mailboxes")
        if not isinstance(mailboxes, list) or not mailboxes:
            mailboxes = ["INBOX", "Junk"]
        top = parse_top(params, default=DEFAULT_TOP)

        all_messages: list[dict[str, Any]] = []
        next_refresh = credentials["refresh_token"]
        sources: set[str] = set()
        for mailbox in mailboxes:
            messages, next_refresh, source = fetch_messages(
                refresh_token=next_refresh,
                client_id=credentials["client_id"],
                email_address=credentials["email"],
                mailbox=normalize_mailbox(str(mailbox)),
                top=top,
            )
            sources.add(source)
            all_messages.extend(graph_shape(mail) for mail in messages)

        all_messages.sort(key=message_timestamp, reverse=True)
        return jsonify(
            {
                "ok": True,
                "messages": all_messages,
                "nextRefreshToken": next_refresh,
                "source": ",".join(sorted(sources)),
            }
        )

    return safe_json(run)


@APP.route("/health", methods=["GET"])
@APP.route("/api/health", methods=["GET"])
def handle_health() -> Response:
    return jsonify(
        {
            "ok": True,
            "status": "ok",
            "service": "outlook-helper-local-api",
            "port": PORT,
            "deleteEnabled": ENABLE_DELETE,
            "time": int(time.time()),
        }
    )


def safe_json(func):
    try:
        return func()
    except HelperError as exc:
        LOGGER.warning("Request failed: %s", exc)
        return jsonify({"error": str(exc), "ok": False}), exc.status_code
    except Exception as exc:
        LOGGER.error("Unhandled error: %s\n%s", exc, traceback.format_exc())
        return jsonify({"error": str(exc), "ok": False}), 500


if __name__ == "__main__":
    LOGGER.info("Starting local Outlook/Hotmail API on http://%s:%s", HOST, PORT)
    APP.run(host=HOST, port=PORT, debug=False, threaded=True)
