# Connecting Google mail and calendar

Atrium reads Gmail and Google Calendar with your own Google Cloud OAuth client, so no shared app ever holds your
mail. It takes about five minutes, once. Everything is optional: Apple Mail and Calendar work without it.

## 1. Make a project and turn on the APIs

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project (any name, say "Atrium").
2. In **APIs & Services › Library**, turn on the **Gmail API** and the **Google Calendar API**.

## 2. Set up the consent screen

1. Open **Google Auth Platform** (or **APIs & Services › OAuth consent screen**).
2. Choose **External**, give the app a name, and use your own address for the support and developer contact.
3. Under **Audience**, add your own Google address (and any other account you'll connect) as a **test user**.
4. Still under **Audience**, press **Publish app** and confirm, so the status reads **In production**.

   This matters: Google ends sign-ins after 7 days for an app left in **Testing**, so Atrium would be signed out every
   week. Publishing doesn't make the app public or send it for review. It stays unverified and only you use it.

## 3. Create the client

1. Under **Clients** (or **Credentials › Create credentials › OAuth client ID**), choose **Desktop app**.
2. Copy the **client ID**, which ends in `.apps.googleusercontent.com`, and the **client secret** if one is shown.

## 4. Connect

In Atrium, open **Settings › Accounts** (or the **Mail and calendar** step of Get started), paste the client ID and
secret, and press **Connect Google**. Your browser opens Google's sign-in; choose the account.

Google then shows a screen saying it **hasn't verified this app**. That's expected: the app is your own, made in your
own project, and Google only verifies apps that other people use. Press **Advanced**, then **Go to (your app's
name)**, and allow the access it asks for.

If Atrium later says Google signed it out and mentions Testing, go back to step 2.4 and publish the app, then
connect again.

Atrium asks for:

- `gmail.modify`: read mail and labels. Later versions use it to save drafts and send, only after you press Send.
- `calendar.events` and `calendar.readonly`: read your calendars and events.

## What Atrium keeps

- The sign-in token is stored in your Mac's Keychain, never in Atrium's database or files.
- Mail and events are cached in Atrium's database on this Mac: the last 30 days of mail and calendar from 30 days
  back to 90 days ahead. Change these in Settings › Accounts.
- Message bodies are fetched when you open a thread or ask about it, kept as plain text, and capped at 2 MB each and
  200 MB in all.
- Mail goes only to Claude, only for tasks in the Inbox space, and is marked as untrusted text there.

**Disconnect** in Settings › Accounts removes the token from the Keychain and the account's cached mail. You can
also remove Atrium's access from your Google account under **Security › Third-party access**.

Add more accounts by pressing **Connect another Google account**; each needs to be a test user of your client.
