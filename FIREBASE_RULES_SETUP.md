# Firebase Rules Setup — Property Zone

Project ID: `property-zone-17121`

## Important

GitHub Pages deploys the website files only. It does **not** automatically publish Firestore or Storage security rules to Firebase. The rules below must be published once in the Firebase Console.

## 1. Publish Firestore Rules

1. Open Firebase Console and select project `property-zone-17121`.
2. Open **Firestore Database → Rules**.
3. Open the repository file [firestore.rules](https://github.com/mdsakilhossen7011-ship-it/property-zone/blob/main/firestore.rules).
4. Copy the complete file contents and replace the rules in the Firebase editor.
5. Click **Publish**.

These rules protect member profiles, property submissions, support messages, notices, offers, admin records, referral-code lookup and referral signup counts. Referral counts use a separate record collection so referrers do not get access to other members' email addresses or profile data.

## 2. Publish Storage Rules

1. In Firebase Console, open **Storage → Rules**.
2. Open the repository file [storage.rules](https://github.com/mdsakilhossen7011-ship-it/property-zone/blob/main/storage.rules).
3. Copy the complete file contents into the Storage Rules editor.
4. Click **Publish**.

Storage rules allow public reads of property images and restrict uploads/deletes to the verified admin. Uploads are limited to JPG, PNG or WebP images smaller than 5 MB.

## 3. After publishing

- Sign in to the Admin Panel with the authorised, email-verified admin account.
- Open Referrals once. The Admin Panel will backfill referral-code lookup records and migrate existing referral signups into the private count records.
- Test member registration with a valid referral code, then check the member dashboard referral count.
- Test a member property submission and approve it from the Admin Panel.
- Test creating, editing and publishing an offer and a notice.

## Security note

Do not make the `members` collection publicly readable. Only admins can list member profiles; a referrer can read only the minimal referral signup records for their own code.
