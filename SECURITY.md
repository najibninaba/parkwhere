# Security policy

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** button on the repository's **Security** tab, which sends a private report to the maintainer.

Include what you found, how to reproduce it, and the impact you expect. You'll get a reply within a week.

## Scope

In scope:
- the Worker API (`/api/*`, `/health`) and the web app at https://parkwhere.bijan.app
- the GitHub Actions workflows, especially anything that could expose deploy secrets to pull request code

Out of scope:
- the upstream services ParkWhere reads (data.gov.sg, LTA DataMall, OneMap). Report problems with those to their owners.
- reports that need a stolen device, or physical access to the maintainer's accounts
