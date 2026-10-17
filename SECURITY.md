# Security Policy

## Supported Versions

Every published package (`@nifrajs/*`, `nifra`, `create-nifra`) is released together at one version. Security fixes ship as a patch release of the latest minor. The previous minor of the current major gets security fixes as patch releases for 90 days after the next minor ships.

| Version                 | Supported                                        |
| ----------------------- | ------------------------------------------------ |
| latest 5.x minor        | :white_check_mark:                               |
| previous 5.x minor      | security fixes, for 90 days after the next minor |
| older 5.x minors, < 5.0 | :x:                                              |

## Reporting a Vulnerability

Please do not report a security vulnerability in a public issue, discussion, or pull request.

Report it privately through GitHub: [open a private security advisory](https://github.com/nifrajs/nifra/security/advisories/new). If you cannot use GitHub, email **security@nifra.dev**.

Please include:
- A description of the vulnerability and its potential impact.
- The affected package and version, and the runtime (Bun, Node, Deno, or an edge platform).
- Detailed steps to reproduce the issue (code samples, screenshots, or curl commands are highly appreciated).
- Any details of potential remediations or workarounds.

We will acknowledge receipt of your report within 48 hours and work with you to coordinate a disclosure timeline and fix. Once a fix is released, we publish a GitHub security advisory and credit the reporter unless you ask us not to.
