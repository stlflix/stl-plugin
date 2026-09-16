#!/usr/bin/env python3
"""Generate a hardened .env for the STLFLIX ops self-hosted Supabase stack."""
import base64, hashlib, hmac, json, secrets, sys, time, pathlib

DOCKER = pathlib.Path("/home/ubuntu/supabase-ops/supabase/docker")
ENV = DOCKER / ".env"
if ENV.exists():
    sys.exit(f"refusing to overwrite existing {ENV}")

def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def jwt(role: str, secret: str, years: int = 5) -> str:
    now = int(time.time())
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64(json.dumps(
        {"role": role, "iss": "supabase", "iat": now, "exp": now + years * 31536000},
        separators=(",", ":"),
    ).encode())
    signing_input = f"{header}.{payload}".encode()
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64(sig)}"

STUDIO_HOST = "db.stlflix.com.br"
dashboard_user, dashboard_pass = "stlflix", secrets.token_urlsafe(24)
jwt_secret = secrets.token_hex(32)          # 64 chars, >= 32 required
values = {
    "COMPOSE_FILE": "docker-compose.yml:docker-compose.override.yml",
    "POSTGRES_PASSWORD": secrets.token_hex(24),
    "JWT_SECRET": jwt_secret,
    "ANON_KEY": jwt("anon", jwt_secret),
    "SERVICE_ROLE_KEY": jwt("service_role", jwt_secret),
    "SUPABASE_PUBLISHABLE_KEY": "",
    "SUPABASE_SECRET_KEY": "",
    "JWT_KEYS": "",
    "JWT_JWKS": "",
    "ANON_KEY_ASYMMETRIC": "",
    "SERVICE_ROLE_KEY_ASYMMETRIC": "",
    "DASHBOARD_USERNAME": dashboard_user,
    "DASHBOARD_PASSWORD": dashboard_pass,
    "SECRET_KEY_BASE": secrets.token_urlsafe(48),
    "REALTIME_DB_ENC_KEY": secrets.token_hex(8),      # 16 chars
    "VAULT_ENC_KEY": secrets.token_hex(16),           # 32 chars
    "PG_META_CRYPTO_KEY": secrets.token_hex(16),      # 32 chars
    "LOGFLARE_PUBLIC_ACCESS_TOKEN": secrets.token_hex(16),
    "LOGFLARE_PRIVATE_ACCESS_TOKEN": secrets.token_hex(16),
    "S3_PROTOCOL_ACCESS_KEY_ID": secrets.token_hex(16),
    "S3_PROTOCOL_ACCESS_KEY_SECRET": secrets.token_hex(32),
    # Phase 1 keeps every surface on loopback; Phase 3 swaps these for the subdomain.
    "SUPABASE_PUBLIC_URL": f"https://{STUDIO_HOST}",
    "API_EXTERNAL_URL": f"https://{STUDIO_HOST}/auth/v1",
    "SITE_URL": f"https://{STUDIO_HOST}",
    "ADDITIONAL_REDIRECT_URLS": "",
    "POSTGRES_HOST": "db",
    "POSTGRES_DB": "postgres",
    "POSTGRES_PORT": "5432",
    "POOLER_PROXY_PORT_TRANSACTION": "6543",
    "POOLER_DEFAULT_POOL_SIZE": "20",
    "POOLER_MAX_CLIENT_CONN": "100",
    "POOLER_TENANT_ID": "stlflix-ops",
    "POOLER_DB_POOL_SIZE": "5",
    "STUDIO_DEFAULT_ORGANIZATION": "STLFLIX",
    "STUDIO_DEFAULT_PROJECT": "ops",
    "OPENAI_API_KEY": "",
    "JWT_EXPIRY": "3600",
    "DISABLE_SIGNUP": "false",
    "MAILER_URLPATHS_CONFIRMATION": "/auth/v1/verify",
    "MAILER_URLPATHS_INVITE": "/auth/v1/verify",
    "MAILER_URLPATHS_RECOVERY": "/auth/v1/verify",
    "MAILER_URLPATHS_EMAIL_CHANGE": "/auth/v1/verify",
    "ENABLE_EMAIL_SIGNUP": "true",
    # No SMTP on this box: autoconfirm keeps signup testable without mail.
    "ENABLE_EMAIL_AUTOCONFIRM": "true",
    "SMTP_ADMIN_EMAIL": "admin@stlflix.com",
    "SMTP_HOST": "supabase-mail",
    "SMTP_PORT": "2500",
    "SMTP_USER": "fake_mail_user",
    "SMTP_PASS": "fake_mail_password",
    "SMTP_SENDER_NAME": "STLFLIX ops",
    "ENABLE_ANONYMOUS_USERS": "false",
    "ENABLE_PHONE_SIGNUP": "false",
    "ENABLE_PHONE_AUTOCONFIRM": "false",
    "GLOBAL_S3_BUCKET": "stub",
    "REGION": "stub",
    "MINIO_ROOT_USER": "supa-storage",
    "MINIO_ROOT_PASSWORD": secrets.token_hex(16),
    "STORAGE_TENANT_ID": "stub",
    "FUNCTIONS_VERIFY_JWT": "false",
    "PGRST_DB_SCHEMAS": "public,graphql_public",
    "PGRST_DB_MAX_ROWS": "1000",
    "PGRST_DB_EXTRA_SEARCH_PATH": "public",
    "DOCKER_SOCKET_LOCATION": "/var/run/docker.sock",
    "GOOGLE_PROJECT_ID": "",
    "GOOGLE_PROJECT_NUMBER": "",
    "API_GW_HTTP_PORT": "8100",
    "KONG_HTTP_PORT": "8100",
    "KONG_HTTPS_PORT": "8443",
    "IMGPROXY_AUTO_WEBP": "true",
    "PROXY_DOMAIN": STUDIO_HOST,
    "CERTBOT_EMAIL": "lucascunhamelo@gmail.com",
    # --- ours (read by docker-compose.override.yml) ---
    "STUDIO_HOST": STUDIO_HOST,
    "STUDIO_BASIC_AUTH_B64": base64.b64encode(f"{dashboard_user}:{dashboard_pass}".encode()).decode(),
    "MCP_ADMIN_KEY": secrets.token_urlsafe(32),
    "MCP_CREDENTIALS_KEY": secrets.token_hex(32),
    "MCP_IMAGE_TAG": "0.2.0",
}
ENV.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
ENV.chmod(0o600)
print(f"wrote {ENV} ({len(values)} vars)")
