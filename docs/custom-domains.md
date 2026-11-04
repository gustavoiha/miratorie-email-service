# Custom domains

The web client and the API can each have their own domain, e.g. `webmail.example.com` (`web`) and
`webmail-api.example.com` (`api`). Without them they use `*.cloudfront.net` and `*.execute-api`
addresses. With `api` set, the `execute-api` URL is disabled and the CSP names the API exactly.

## Certificate

Both names need an ACM certificate, in **two regions**:

| Used by                          | Region            | Config key                     |
| -------------------------------- | ----------------- | ------------------------------ |
| CloudFront (web client)          | `us-east-1`       | `web.certificateArnParameter`  |
| API Gateway custom domain (API)  | deployment region | `api.certificateArnParameter`  |

ACM certificates cannot be shared across regions, so request the same names in both. If you deploy
to `us-east-1`, one certificate serves both: point both keys at the same parameter.

ACM wildcards replace a whole leftmost label only. `webmail*.example.com` is not valid; to cover
both names, either list them as subject alternative names (recommended) or use `*.example.com`.

1. Request the certificate in both regions:

   ```bash
   for region in us-east-1 eu-central-1; do
     aws acm request-certificate --region $region --domain-name webmail.example.com \
       --subject-alternative-names webmail-api.example.com --validation-method DNS
   done
   ```

2. Create the validation CNAMEs at your DNS provider. ACM uses the same records for a name in every
   region of an account, so one set validates both certificates:

   ```bash
   aws acm describe-certificate --region us-east-1 --certificate-arn <us-east-1 arn> \
     --query 'Certificate.DomainValidationOptions[].ResourceRecord'
   ```

3. Store the ARNs in SSM parameters **in the deployment region**:

   ```bash
   aws ssm put-parameter --region eu-central-1 --name /example/certificate-arn --type String --overwrite --value <us-east-1 arn>
   aws ssm put-parameter --region eu-central-1 --name /example/api-certificate-arn --type String --overwrite --value <eu-central-1 arn>
   ```

4. Set `web` and `api` in `infra/config.json`, deploy, then add DNS-only CNAMEs:

   | Name                      | Target                        |
   | ------------------------- | ----------------------------- |
   | `webmail.example.com`     | `DistributionDomain` output   |
   | `webmail-api.example.com` | `ApiDomainTarget` output      |

A renewed or replaced certificate only needs its parameter updated and a redeploy. ACM renews
DNS-validated certificates automatically while the validation CNAMEs stay in place.

## Web client distribution

Mirrors the Miratorie landing page's production distribution: private S3 origin with Origin Access
Control, HTTPS only, compression, HTTP/2 and HTTP/3, all edge locations and an optional web ACL. A
viewer-response CloudFront Function ([infra/lib/security-headers.ts](../infra/lib/security-headers.ts))
adds a strict CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff` and
`X-Robots-Tag: noindex, nofollow`. Files are cached for 5 minutes and old builds are kept in the
bucket so a cached `index.html` still loads.

## Flat-rate pricing plan

Moving the distribution to a CloudFront flat-rate plan in the console attaches a
`CreatedByCloudFront-…` web ACL outside CDK. Before the next deploy, put it in `webAclArn`:

```bash
aws cloudfront get-distribution-config --id <DistributionId output> --query 'DistributionConfig.WebACLId' --output text
```

Otherwise the next deploy that updates the distribution tries to remove the web ACL, and CloudFront
rejects it. `npm run diff` should then show only `WebACLId` being added. Check whether the plan must
be cancelled before `cdk destroy` can delete the distribution. The plan's web ACL only covers the
web client; the API is not behind CloudFront.
