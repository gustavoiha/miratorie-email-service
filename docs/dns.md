# DNS details

## Why these records

- **DKIM** – SES signs as `<domain>`; the three CNAMEs publish its keys.
- **SPF** – checked against the envelope sender `mail.<domain>` (custom MAIL FROM). The apex SPF
  record covers receivers that check the `From:` domain.
- **DMARC** – passes when DKIM or SPF passes *and* aligns (relaxed) with the `From:` domain, which
  both do with this setup.

## Provider notes

- Many providers want relative names: `<token>._domainkey`, `mail`, `_dmarc`, `@`.
- If the MX priority is a separate field, enter `10` and only the host name as the value.
- Records must be DNS-only (e.g. not proxied on Cloudflare).
- **One SPF record per name.** Merge with an existing one, e.g.
  `v=spf1 include:_spf.google.com include:amazonses.com ~all`.
- Remove other MX records for the domain.
- A `rua` address on another domain needs `<domain>._report._dmarc.<other-domain> TXT "v=DMARC1"`.
- A common mistake is the provider appending the domain twice (`…_domainkey.example.com.example.com`).
- DKIM tokens change only if the SES identity is recreated (new `stackPrefix` or `domainName`).

## DMARC rollout

If the domain already sends mail elsewhere, start with `p=none` and a `rua` address, move to
`quarantine` once all senders pass, then `reject`. A domain that only sends through this service
can start at `quarantine` or `reject`. Keep `dmarc.policy` in the config in sync with the record.

## Verify

```bash
dig +short MX example.com
dig +short TXT example.com
dig +short TXT _dmarc.example.com
dig +short MX mail.example.com
dig +short TXT mail.example.com
```

Then send a message to an external mailbox and check that the headers show SPF, DKIM and DMARC `PASS`.
