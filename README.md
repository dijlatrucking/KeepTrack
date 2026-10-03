# KeepTrack

Loads, paperwork and pay for a dispatch service and the carriers it works for. A Spartan Groups LLC service.

**Who sees what**

| Role | Sees | Can do |
|---|---|---|
| Owner | Everything, every carrier | Add carriers, invite carrier admins and dispatchers, assign dispatchers to carriers, book loads, approve docs, mark fees paid |
| Dispatcher | Only the carriers the owner assigns (or all) | Book loads (rate + fee), update status, approve/reject driver docs, answer truck requests |
| Carrier admin | Only their own company, full money breakdown | Invite/remove drivers, set driver pay, add/remove trucks, document vault with search, request loads/lanes, issue paystubs |
| Driver | Only their own loads, uploads and paystubs (never rates or fees) | Mark picked up / delivered, photo-upload BOLs, PODs and receipts |

Paperwork flows up: driver uploads → dispatch approves → carrier admin and owner see it.

## Stack

Plain HTML/CSS/JS (no build step) on Firebase: Authentication (email/password) and Cloud Firestore, all on the free Spark plan. Scans are shrunk in the browser and stored in Firestore (`docFiles`), so Cloud Storage is not required. Security lives in `firestore.rules` (`storage.rules` is only needed if Storage is turned on later).

## One-time setup (can all be done from a phone browser)

1. **Firebase console → project KeepTrack**
   - Add app → Web → nickname `KeepTrack` → Register. Copy the `firebaseConfig` values into `js/firebase-config.js`.
   - Authentication → Get started → Email/Password → Enable.
   - Firestore Database → Create database → production mode.
   - (Optional, later) Storage → Get started. Not needed: scans are saved in Firestore.
2. **Paste the security rules**
   - Firestore Database → Rules → replace everything with `firestore.rules` → Publish.
   - (Only if Storage is on) Storage → Rules → paste `storage.rules` → Publish.
3. **Put the site online with GitHub Pages**
   - GitHub repo → Settings → Pages → Source: Deploy from a branch → `main` / root → Save.
   - Firebase → Authentication → Settings → Authorized domains → add `dijlatrucking.github.io`.
4. **Make yourself the owner** (only needed once)
   - Firebase → Authentication → Users → Add user with your email and a password. Copy the new **User UID**.
   - Firestore → Start collection `users` → Document ID = your UID → fields: `role` (string) `owner`, `name` (string) your name, `email` (string) your email.
   - Sign in on the site. You're the owner.
5. **Start using it**
   - Carriers → add your own company, then client carriers (set each one's dispatch fee %).
   - Invite a carrier admin for each carrier, and dispatchers from Team. Each invite code works once.
   - Or let them sign up with **Request access**: they show up under Access requests (and on Overview), and one tap approves them. Approving a carrier creates the company too.
   - Carrier admins invite their own drivers.

## Data model

- `users/{uid}`: name, email, role, carrierId, (dispatcher) assignedCarriers[] / allCarriers, (driver) payType, payRate, truckId
- `carriers/{id}`: name, mc, dot, phone, feePercent
- `trucks/{id}`: carrierId, unit, type, vin, plate, regExpires
- `loads/{id}`: carrierId, origin, destination, pickupDate, deliverBy, miles, driverId/driverName, truckId/truckUnit, dispatcherId, status
- `loadMoney/{loadId}`: carrierId, rate, fee, feePaid (kept separate so drivers never see it)
- `documents/{id}`: carrierId, loadId, kind/category, name, tags, expiresAt, storagePath, uploadedBy, status (pending/approved/rejected/filed); truck and driver files also carry truckId + truckUnit or driverId + driverName (category "Truck files" / "Driver files"). A driver can read the filed papers of the truck they're assigned and their own driver file.
- `requests/{id}`: carrierId, truckId, text, status, reply
- `paystubs/{id}`: carrierId, driverId, period, loads[], gross, deductions, net
- `invites/{code}`: role, carrierId, used, usedBy

## Coming next

In-app messaging between drivers, dispatch and carriers.
