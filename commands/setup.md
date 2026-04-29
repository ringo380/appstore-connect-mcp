---
name: setup
description: Interactive setup wizard for App Store Connect MCP credentials
---

Walk the user through configuring their App Store Connect API credentials. Follow these steps exactly:

## Step 1 — Check current state

Run: `grep "APP_STORE" ~/.zshenv 2>/dev/null`

If all three vars (`APP_STORE_KEY_ID`, `APP_STORE_ISSUER_ID`, `APP_STORE_P8_PATH`) are already set, tell the user they're already configured and ask if they want to update them. If they say no, stop here.

## Step 2 — Explain where to get credentials

Tell the user:

> You'll need three things from App Store Connect → Users and Access → Integrations → API Keys:
>
> 1. **Key ID** — 10-character string (e.g. `A1B2C3D4E5`)
> 2. **Issuer ID** — UUID shown at the top of the API Keys page
> 3. **P8 file** — Downloaded when you created the key (only available once). Save it somewhere permanent like `~/.private_keys/AuthKey_<KEY_ID>.p8`
>
> If you don't have an API key yet, create one with "Admin" or "Developer" role.

## Step 3 — Collect credentials

Ask the user to provide:
1. Their **Key ID**
2. Their **Issuer ID**  
3. The **full path** to their `.p8` file (expand `~` to the actual home directory path)
4. (Optional) Their **Vendor Number** — only needed for financial/sales reports. Found in App Store Connect → Payments and Financial Reports.

Collect all answers before proceeding.

## Step 4 — Validate the P8 path

Run: `ls -la "<p8_path>"` to confirm the file exists. If it doesn't, tell the user and ask them to double-check the path before continuing.

## Step 5 — Write to ~/.zshenv

Read `~/.zshenv` first, then append the vars. If any of the vars already exist in the file, replace them rather than duplicating.

Write/update these lines:
```
export APP_STORE_KEY_ID="<key_id>"
export APP_STORE_ISSUER_ID="<issuer_id>"
export APP_STORE_P8_PATH="<p8_path>"
```

If the user provided a vendor number, also add:
```
export APP_STORE_VENDOR_NUMBER="<vendor_number>"
```

## Step 6 — Reconnect

Tell the user:

> Credentials saved to `~/.zshenv`. To activate:
>
> 1. Run `/mcp` in Claude Code
> 2. Find **appstore-connect** in the list
> 3. Click **Reconnect**
>
> Then use `test_connection` to verify everything works.
