#!/usr/bin/env python3
"""Generate the .env of the BuildLoop stack: seven values, none of them typed by hand.

Usage: gen-env.py [directory]   (default: the directory of this script)

It refuses to overwrite an existing .env. Regenerating would change
POSTGRES_PASSWORD under a live database and MCP_CREDENTIALS_KEY under the
encrypted role passwords — every collaborator would lose their credential at
once. Rotating is a deliberate act, not a re-run.
"""
import pathlib
import secrets
import subprocess
import sys

BUILDLOOP_HOST = "db.stlflix.com"

KEY_ORDER = [
    "BUILDLOOP_HOST",
    "POSTGRES_PASSWORD",
    "MCP_ADMIN_KEY",
    "MCP_CREDENTIALS_KEY",
    "RUNTIME_KEY",
    "AUTH_PRIVATE_KEY",
    "AUTH_PUBLIC_KEY",
]


def run(args: list[str], stdin: bytes | None = None) -> bytes:
    """openssl, or nothing: a hand-rolled EC keypair is not worth the risk."""
    result = subprocess.run(args, input=stdin, capture_output=True)
    if result.returncode != 0:
        sys.exit(f"{' '.join(args)} failed: {result.stderr.decode().strip()}")
    return result.stdout


def es256_pair() -> tuple[str, str]:
    """P-256 (prime256v1) is the curve ES256 is defined over; PKCS8 is what `jose` reads."""
    raw = run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout"])
    private = run(["openssl", "pkcs8", "-topk8", "-nocrypt"], stdin=raw)
    public = run(["openssl", "ec", "-pubout"], stdin=private)
    return private.decode().strip(), public.decode().strip()


def env_line(key: str, value: str) -> str:
    # A PEM is several lines and a .env value is one: the newlines travel
    # escaped, inside double quotes, which is what Compose un-escapes on the
    # way in (and what `config.js` normalises again, so either behaviour works).
    if "\n" in value:
        return f'{key}="{value.replace(chr(10), chr(92) + "n")}"\n'
    return f"{key}={value}\n"


def main() -> None:
    directory = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else __file__).resolve()
    if directory.is_file():
        directory = directory.parent
    env_path = directory / ".env"
    if env_path.exists():
        sys.exit(f"refusing to overwrite existing {env_path}")

    private, public = es256_pair()
    values = {
        "BUILDLOOP_HOST": BUILDLOOP_HOST,
        # hex only: it goes inside a connection URI in the compose file.
        "POSTGRES_PASSWORD": secrets.token_hex(24),
        "MCP_ADMIN_KEY": secrets.token_urlsafe(32),
        # 32 bytes as 64 hex characters: `crypto.js` refuses anything else.
        "MCP_CREDENTIALS_KEY": secrets.token_hex(32),
        "RUNTIME_KEY": secrets.token_urlsafe(32),
        # The signing half belongs to the platform (BUILDLOOP_AUTH_PRIVATE_KEY),
        # never to this stack: copy it there and delete nothing else.
        "AUTH_PRIVATE_KEY": private,
        "AUTH_PUBLIC_KEY": public,
    }
    assert list(values) == KEY_ORDER

    env_path.write_text("".join(env_line(key, values[key]) for key in KEY_ORDER))
    env_path.chmod(0o600)
    print(f"wrote {env_path} ({len(values)} keys)")
    print("copy AUTH_PRIVATE_KEY to the platform as BUILDLOOP_AUTH_PRIVATE_KEY: that is the only place it belongs")


if __name__ == "__main__":
    main()
