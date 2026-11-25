# Rangreza — AI Embellishment Matching

A web app that matches a fabric to the right traditional embellishments (lace, gota, dabka, buttons, beads, motifs) and shows the shop that sells each one. BBA capstone FYP — AI Powered Embellishment Matching Application for Traditional Pakistani Clothing.

**Live app:** https://rangeeza-app.netlify.app

## What it does

Upload a fabric photo (or pick a colour). The app ranks every embellishment by how well it fits, explains *why*, and builds a "complete the look" bundle (border, neckline, sleeves, dupatta). It has three separate logins:

- **Shop** — customers match fabrics, find vendors, and place orders.
- **Vendor** — shopkeepers list stock and manage orders for their own shop.
- **Admin** — approves shops, moderates listings, and runs the evaluation.

## The AI

Matching uses a single score, **RMS**, blending five signals:

```
RMS = 0.30×Colour + 0.25×Vision + 0.15×Fabric + 0.15×Pattern + 0.15×Occasion
```

- **Colour** — colour harmony in the CIELAB colour space.
- **Vision (CLIP)** — a real CLIP vision model runs in the browser and turns each photo into a 512-number embedding; close embeddings mean a close visual match.
- **Fabric / Pattern / Occasion** — fabric weight, pattern busyness, and event fit (wedding, mehndi, etc.).

The Admin → Evaluation page scores the hybrid against colour-only and vision-only baselines plus five ablations, using Precision@K, Recall@K and NDCG@K, with CSV export.

## Architecture

- **Frontend:** one self-contained `index.html` (hosted on Netlify). The matching engine and CLIP run in the browser.
- **Backend:** Supabase (hosted Postgres). 6 tables, 12 row-level-security rules, and 13 database functions. Security is enforced in the database, not the page — nobody can make themselves admin, change a price, or see another person's orders.
- **Serverless:** one Supabase Edge Function (`analyze-image`) re-reads each uploaded photo's colour and texture on the server.
- **Live updates:** Supabase Realtime pushes new orders to vendors and status changes to customers instantly.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The whole deployable app (frontend + AI engine, bundled). |
| `backend/schema.sql` | The database: tables, security rules, and functions. **This is the backend.** |
| `backend/functions/analyze-image/index.ts` | The Supabase Edge Function (server-side photo check). |
| `src/` | The readable source that builds into `index.html` (see below). |
| `docs/SETUP_GUIDE.md` | How to set up Supabase + Netlify. |
| `docs/Backend_and_Demo.pdf` | Plain-language backend overview + demo script. |

### `src/` files

| File | Role |
|---|---|
| `ai_engine_matching_RMS.js` | RMS scoring, ranking, explanations, bundles, evaluation metrics. |
| `ai_engine_colour_texture.js` | CIELAB colour harmony and the texture reader. |
| `app_clip_catalogue_cart.js` | CLIP vision model loading, image embeddings, the Shop. |
| `app_auth_orders_realtime.js` | Logins, the three portals, orders, live notifications. |
| `app_admin_evaluation.js` | Admin portal and the evaluation page. |
| `layout.html`, `styles_base.css`, `styles_v4.css` | Page structure and styling. |
| `build.py` | Combines the `src/` files into the single `index.html`. |

## Run it locally

Open `index.html` in a browser. It connects to the hosted Supabase backend. To rebuild from source after editing `src/`:

```
python3 src/build.py
```

## Notes

- The Supabase anon key in `index.html` is a public key by design; the database's security rules are what protect the data.
- The CLIP vision model (~90 MB) downloads once into the browser on first use and is cached.
