# AutoBody Production Board — Setup Guide

## Prerequisites
- Node.js 18+ installed
- A Google account (for Firebase)

---

## Step 1: Create Firebase Project

1. Go to https://console.firebase.google.com
2. Click **"Add project"** → name it (e.g. `autobody-board`) → Continue
3. Disable Google Analytics if you don't need it → **Create project**

### Enable Authentication
- In Firebase Console → **Authentication** → Get started
- **Sign-in method** tab → Enable **Email/Password** → Save

### Enable Firestore
- **Firestore Database** → Create database
- Choose **"Start in production mode"** → Select your region (us-central1 recommended) → Enable

### Deploy Security Rules
- In **Firestore → Rules** tab, paste the contents of `firestore.rules` → Publish

---

## Step 2: Get Firebase Config

1. Firebase Console → **Project Settings** (gear icon) → **Your apps**
2. Click **"</>  Web"** → Register app (name: `autobody-board`) → Continue
3. Copy the `firebaseConfig` values

---

## Step 3: Configure the App

```bash
cd autobody-board

# Copy the example env file
cp .env.example .env
```

Open `.env` and fill in your Firebase values:
```
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=autobody-board.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=autobody-board
VITE_FIREBASE_STORAGE_BUCKET=autobody-board.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
```

---

## Step 4: Install & Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 — you'll see the login page.

---

## Step 5: Create Your Admin Account (First Time)

Since there are no users yet, you need to create the first account manually:

1. Firebase Console → **Authentication** → **Users** → **Add user**
   - Email: your email (e.g. `aaron@yourshop.com`)
   - Password: set a strong password
   - Copy the **User UID** shown

2. Firebase Console → **Firestore** → **Start collection**
   - Collection ID: `users`
   - Document ID: paste your UID from step above
   - Add fields:
     - `name` (string): `Aaron`
     - `email` (string): `aaron@yourshop.com`
     - `role` (string): `shop_manager`
     - `active` (boolean): `true`

3. Log in at http://localhost:5173 with your email + password
4. Go to **Team** page → Add all other employees (they'll get password-setup emails)

---

## Step 6: Deploy to Firebase Hosting (Optional)

```bash
# Install Firebase CLI
npm install -g firebase-tools
firebase login

# Initialize hosting
firebase init hosting
# → Use existing project → select autobody-board
# → Public directory: dist
# → Single-page app: YES
# → Don't overwrite index.html

# Build + deploy
npm run build
firebase deploy --only hosting
```

Your app will be live at `https://autobody-board.web.app`

---

## Firestore Collections Reference

### `users/{uid}`
| Field | Type | Description |
|-------|------|-------------|
| name | string | Full name |
| email | string | Login email |
| role | string | One of: shop_manager, production_manager, estimator, body_man, painter, paint_helper, parts_manager |
| phone | string | Optional |
| active | boolean | Set false to deactivate |

### `ros/{autoId}`
| Field | Type | Description |
|-------|------|-------------|
| roNumber | string | Your RO number from CCC |
| customerName | string | |
| vehicle | string | "Year Make Model" |
| status | string | See pipeline stages |
| promisedDate | string | YYYY-MM-DD |
| assignedBodyMan | string | User UID |
| assignedPainter | string | User UID |
| partsStatus | string | not_ordered / ordered / partially_received / all_received |

### `tasks/{autoId}`
| Field | Type | Description |
|-------|------|-------------|
| roId | string | Reference to RO document ID |
| assignedTo | string | User UID |
| title | string | Task description |
| status | string | pending / in_progress / completed |
| priority | string | low / medium / high |

---

## Role Permissions Summary

| Feature | Shop Mgr | Prod Mgr | Estimator | Body Man | Painter | Paint Helper | Parts Mgr |
|---------|----------|----------|-----------|----------|---------|--------------|-----------|
| See all ROs | ✓ | ✓ | ✓ | filtered | filtered | filtered | filtered |
| Add/Edit RO | ✓ | ✓ | ✓ | — | — | — | — |
| Update status | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Update parts | ✓ | ✓ | — | — | — | — | ✓ |
| Assign tasks | ✓ | ✓ | — | — | — | — | — |
| Team management | ✓ | ✓ | — | — | — | — | — |

---

## Coming Next (Phase 2)
- Chrome Extension to pull ROs directly from CCC board
- DingTalk meeting notes import + AI task parsing
- SMS/push notifications for task assignments
- Weekly production reports
