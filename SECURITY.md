# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@sheer.invalid** (placeholder address, replaced before the first release).
Do not open public issues for vulnerabilities.

Please include: affected version, platform, a description of the issue, and, if possible, a proof-of-concept file.
Malicious PDF samples are welcome; please send them as a password-protected archive.

## Our commitment

- We acknowledge reports within 7 days.
- We aim to ship a fix within 90 days. After a fix is released, or after 90 days at the latest, the issue may be disclosed publicly (coordinated disclosure).
- We credit reporters in the release notes unless they prefer to stay anonymous.

## Scope

Sheer is an offline desktop app. Relevant issues include, for example: code execution or crashes caused by crafted PDF files,
access to local files outside what the user opened, data leaking out of the device, update or supply-chain integrity problems,
and redaction that does not actually remove content.

The internal threat model and checklist live in [docs/SECURITY.md](docs/SECURITY.md).
