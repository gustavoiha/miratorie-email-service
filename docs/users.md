# Managing users

| Attribute              | Example                    | Purpose                                                              |
| ---------------------- | -------------------------- | -------------------------------------------------------------------- |
| username               | `alice@example.com`        | Sign-in name (the mailbox address is recommended)                    |
| `name`                 | `Alice Smith`              | Display name in `From:`                                              |
| `phone_number`         | `+447700900123`            | E.164                                                                |
| `custom:primary_email` | `alice@example.com`        | The mailbox; must be on the domain; not writable by users            |
| `email`                | `alice.personal@gmail.com` | Secondary email: invitation, verification and password-reset codes   |

`email_verified=true` at creation is safe: the temporary password is delivered to that address.

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name MiratorieEmail-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
U=alice@example.com

# Resend the invitation (temporary passwords expire after 7 days)
aws cognito-idp admin-create-user --user-pool-id "$USER_POOL_ID" --username $U --message-action RESEND --desired-delivery-mediums EMAIL

# Change the recovery email
aws cognito-idp admin-update-user-attributes --user-pool-id "$USER_POOL_ID" --username $U \
  --user-attributes Name=email,Value=alice.new@gmail.com Name=email_verified,Value=true

# Revoke access (account and mail are kept)
aws cognito-idp admin-remove-user-from-group --user-pool-id "$USER_POOL_ID" --username $U --group-name email-users
aws cognito-idp admin-user-global-sign-out --user-pool-id "$USER_POOL_ID" --username $U

# Disable or delete
aws cognito-idp admin-disable-user --user-pool-id "$USER_POOL_ID" --username $U
aws cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username $U

# List members
aws cognito-idp list-users-in-group --user-pool-id "$USER_POOL_ID" --group-name email-users
```

## Collective addresses

List shared addresses in `collectiveAddresses` in `infra/config.json` and deploy; each gets a group
`mailbox:<address>`. Members can read and send from the address and share its folders and read
state. A user may have only collective addresses (no `custom:primary_email`).

```bash
# Add or remove a member
aws cognito-idp admin-add-user-to-group --user-pool-id "$USER_POOL_ID" --username $U --group-name mailbox:contact@example.com
aws cognito-idp admin-remove-user-from-group --user-pool-id "$USER_POOL_ID" --username $U --group-name mailbox:contact@example.com

# List members
aws cognito-idp list-users-in-group --user-pool-id "$USER_POOL_ID" --group-name mailbox:contact@example.com
```

Mail sent to the address before the group existed is already stored and becomes visible to members.
Removing an address from the config deletes its group, not its mail.

Notes:

- Deleting a user keeps their mail in S3 and DynamoDB.
- Cognito's default email sender allows about 50 emails per day per pool.
- Group and attribute changes apply at the next token refresh (≤ 1 hour) or after signing in again.
