# Security Policy

## Status

Sheer is **pre-release software** until v2.0.0. Builds are unsigned (see the README); use them at your own risk. Security fixes go into the
latest version only.

## Reporting a vulnerability

Please report security issues privately through GitHub's **private vulnerability reporting**: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open public issues for vulnerabilities.

Please include: affected version, platform, a description of the issue, and, if possible, a proof-of-concept file.
Malicious PDF samples are welcome; attach them as a password-protected archive and put the password in the report.

## Our commitment

- We acknowledge reports within 7 days.
- We aim to ship a fix within 90 days. After a fix is released, or after 90 days at the latest, the issue may be disclosed publicly (coordinated disclosure).
- We credit reporters in the release notes unless they prefer to stay anonymous.

## Scope

Sheer is an offline desktop app. Relevant issues include, for example: code execution or crashes caused by crafted PDF files,
access to local files outside what the user opened, data leaking out of the device, update or supply-chain integrity problems,
and redaction that does not actually remove content.

The internal threat model and checklist live in [docs/SECURITY.md](docs/SECURITY.md).
