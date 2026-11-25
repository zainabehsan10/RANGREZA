# Rangreza v4 — What is left for you to do

The database, security rules, photo storage and photo-check function are **already set up and live** in your Supabase project (`qwrioizijwqlnbpsisxl`). The file `ready_to_deploy/index.html` already has your project's address and public key inside it. You need four short steps (about 15 minutes).

---

## Step 1 — Turn off "Confirm email" (important)

Supabase dashboard → **Authentication** → **Sign In / Providers** → **Email** → switch **Confirm email** OFF → Save.

Why: the app expects a new customer or vendor to be signed in straight after creating an account. With confirmation on, sign-up looks like it failed until they click a link in their inbox. (For a big public launch you can turn it back on later, once you have a proper email sender.)

## Step 2 — Put the app online (Netlify)

1. Go to app.netlify.com and sign in.
2. **Add new site** → **Deploy manually**.
3. Drag `ready_to_deploy/index.html` into the box. (The file must be called `index.html`.)
4. Netlify gives you an address like `something.netlify.app`. Open it.

## Step 3 — Tell Supabase your website address

Supabase dashboard → **Authentication** → **URL Configuration** → set **Site URL** to your Netlify address → Save. This makes "Forgot password" emails come back to your app.

## Step 4 — Make your admin account

Admin accounts cannot be created through the app. This is deliberate, so nobody can sign up as an admin.

1. In the app: **Shop → My Account & Orders → Create account**, using the email you want for admin. Use an email you do not use for any other Rangreza account (each email is exactly one role).
2. Send me that email and I will promote it. Or run this yourself in Supabase → **SQL Editor**:

```sql
update public.profiles
   set role = 'admin'
 where id = (select id from auth.users where email = 'YOUR_EMAIL_HERE');
```

3. Open the **Admin** portal and sign in.

---

## Already done for you

- Database tables, security rules, order function, photo bucket, live updates.
- Security verified on your real database (29 checks: nobody can make themselves admin, change prices, see other people's orders, or sell from an unapproved shop).
- Optional server-side photo re-check (`analyze-image`) is deployed. It needs no secrets.

---

## First run: the checklist

1. **Admin portal:** sign in. You should see the overview with zeros.
2. **Vendor portal:** create a vendor account (different email). You should see "Awaiting approval". Add one item with a photo.
3. **Admin → Vendors:** approve that shop.
4. **Shop:** the item appears. Upload a fabric photo and check the matches and the "Complete the look" card.
5. **Shop:** create a customer account (another email), add the item, place the order.
6. **Vendor portal → Orders:** the order is there with the customer's phone number. Change its status.
7. **Customer → My Account & Orders:** the status updates.
8. **Admin → Overview → Index missing listings** (use desktop Chrome). The first time this downloads the AI vision model (about 90 MB). It adds the AI vectors to your listings and saves the shared label data.

If step 8 fails, nothing else breaks. Matching falls back to colour and texture, and the app tells the customer which mode it is in.

---

## The three portals

| Portal | Who | Sign-up | Can do |
|---|---|---|---|
| **Shop** | Customers | Self-service | Match, find vendor, order, see and cancel own orders |
| **Vendor Portal** | Shopkeepers | Self-service, then admin approval | Add and edit stock, see and update orders for their shop |
| **Admin** | You | Never self-service (step 4) | Approve or suspend shops, hide listings, see all orders, run AI indexing, run the evaluation |

Each email belongs to exactly one portal.

---

## What is real, and what is not

**Real and enforced by the database (not just the page):**
- Roles. Nobody can promote themselves, approve their own shop, or change a price.
- Order prices come from the database when the order is placed.
- A vendor sees only their own shop's order lines. A customer sees only their own orders.
- New shops are invisible to customers until approved.

**Honest limits:**
- **The app has not yet been clicked through against your live project.** I tested the whole app in a real browser against a simulated Supabase (56 checks, plus 30 on the scoring maths), and tested the live database's security rules directly. The first real end-to-end run is your checklist above. If anything errors, send me the exact message.
- **CLIP has not been run.** My environment cannot download the model. Its first real run is checklist step 8.
- **The RMS weights (30/25/15/15/15) and the 0.5 to 0.95 CLIP similarity range are starting values**, not tuned. The Admin → Evaluation page exists to tune and justify them.
- **No online payment.** Customers pay the shop directly. No stock auto-decrement, no delivery tracking, no email or SMS notifications.
- **Fabric and pattern labels come from CLIP zero-shot.** They are best guesses, not certainties.
- **All shop names, stalls and phone numbers in my test data are invented.** Real launch data must come from real vendors.
- **Moderation is manual.** You approve each shop (Admin → Vendors); you can hide listings (Admin → Listings).

## Evaluation for the FYP

Admin → **Evaluation**: add 10 or more test fabric photos, tick the catalogue items you would pair with each, and read the table. It compares colour-only, CLIP-only, the hybrid score, and five ablations on Precision@K, Recall@K, NDCG@K and latency. **Export CSV** saves the numbers for your report. For credibility, get a boutique owner or tailor to do the ticking.
