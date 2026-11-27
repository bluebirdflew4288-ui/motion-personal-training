#!/usr/bin/env python3
"""Scan Git history before pushing, or scan the exact APK before uploading."""

import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parent.parent
PRIVATE_SUFFIXES = {".jks", ".keystore", ".p12", ".pfx", ".pkcs12", ".pem", ".key", ".pk8"}
PRIVATE_NAMES = {"keystore.properties", "credentials.json", ".npmrc", ".netrc"}
MAX_APK_EXPANDED_SIZE = 256 * 1024 * 1024


def private_file(path):
    name = PurePosixPath(path).name.lower()
    return (
        name in PRIVATE_NAMES
        or PurePosixPath(name).suffix in PRIVATE_SUFFIXES
        or name == ".env"
        or name.startswith((".env.", "secrets."))
        or (name.startswith("motion-backup-") and name.endswith(".json"))
    )


def run_gitleaks(*args):
    env = os.environ.copy()
    env.pop("GITLEAKS_CONFIG_TOML", None)
    env.pop("GITLEAKS_CONFIG", None)
    result = subprocess.run(
        [
            "gitleaks", *args, "--config", str(ROOT / ".gitleaks.toml"),
            "--gitleaks-ignore-path", str(ROOT / ".gitleaksignore"),
            "--ignore-gitleaks-allow", "--max-archive-depth", "2",
            "--max-decode-depth", "2", "--redact=100", "--no-banner", "--exit-code", "42",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode == 42:
        raise ValueError("Gitleaks flagged credentials. Review privately with redaction enabled.")
    if result.returncode:
        raise ValueError(f"Gitleaks could not complete the scan (exit {result.returncode}).")


def scan_apk(apk):
    with ZipFile(apk) as archive, TemporaryDirectory(prefix="motion-apk-scan-") as tmp:
        target = Path(tmp)
        entries = archive.infolist()
        if sum(entry.file_size for entry in entries) > MAX_APK_EXPANDED_SIZE:
            raise ValueError("APK exceeds the scan size limit.")
        if not {"AndroidManifest.xml", "classes.dex"} <= set(archive.namelist()):
            raise ValueError("APK must contain a manifest and primary DEX.")
        for index, entry in enumerate(entries):
            if entry.is_dir():
                continue
            if private_file(entry.filename):
                raise ValueError("APK contains a credential or signing-material filename.")
            # Keep only a generated name and safe extension. ZIP paths never become disk paths.
            suffix = PurePosixPath(entry.filename).suffix
            suffix = suffix if suffix.isascii() and suffix[1:].isalnum() else ""
            extracted = target / f"{index}{suffix}"
            with archive.open(entry) as source, extracted.open("wb") as output:
                shutil.copyfileobj(source, output)
            if suffix.lower() in {".dex", ".arsc", ".xml", ".so"}:
                with (target / f"{index}-strings.txt").open("wb") as strings:
                    subprocess.run(["strings", "-a", "-n", "5", extracted], stdout=strings, check=True)
        run_gitleaks("dir", str(target))


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def scan_git():
    if git("rev-parse", "--is-shallow-repository").strip() != b"false":
        raise ValueError("Use a complete checkout to scan Git history.")
    history_paths = git("log", "--all", "--format=", "--name-only", "-z").split(b"\0")
    if any(private_file(os.fsdecode(path)) for path in history_paths if path):
        raise ValueError("Git history contains a credential or signing-material filename.")
    run_gitleaks("git", "--log-opts=--all -m --full-history", str(ROOT))
    # Git patch scans skip binary changes. Scan every distinct APK blob under reachable refs.
    with TemporaryDirectory(prefix="motion-git-apk-") as tmp:
        apk = Path(tmp) / "candidate.apk"
        for row in git("rev-list", "--objects", "--all").splitlines():
            object_id, _, path = row.partition(b" ")
            if path.lower().endswith(b".apk"):
                with apk.open("wb") as output:
                    subprocess.run(["git", "cat-file", "blob", object_id.decode("ascii")],
                                   cwd=ROOT, stdout=output, check=True)
                scan_apk(apk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path, nargs="*", help="Scan APK files in place of Git history")
    args = parser.parse_args()
    try:
        if args.apk:
            for apk in args.apk:
                if not apk.is_file() or apk.suffix.lower() != ".apk":
                    raise ValueError("Supply an existing APK file.")
                scan_apk(apk)
        else:
            scan_git()
    except ValueError as error:
        print(f"Credential scan failed. {error}", file=sys.stderr)
        return 1
    except (BadZipFile, OSError, RuntimeError, subprocess.CalledProcessError):
        print("Credential scan failed. Check the inputs and ensure Git, strings and Gitleaks are installed.",
              file=sys.stderr)
        return 1

    print("Credential scan passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
