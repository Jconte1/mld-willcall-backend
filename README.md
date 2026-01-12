# mld-willcall-backend

Backend for MLD WillCall staff app (admin + staff) using:
- Express + TypeScript
- PostgreSQL + Prisma
- JWT auth (7 day expiry)
- Password reset via email (1 hour token)

## Setup

1) Install
```bash
npm install
```

2) Create `.env`
Copy `.env.example` to `.env` and fill in values:
- DATABASE_URL
- JWT_SECRET (you can set this equal to NEXTAUTH_SECRET in your frontend)
- FRONTEND_URL (default is https://mld-willcall.vercel.app)
- SMTP_* + AUTO_EMAIL* (only required for password reset email)

3) Prisma migrate
```bash
npm run prisma:generate
npm run prisma:migrate:dev
```

4) (Optional) Seed initial admin
```bash
npm run seed
```

5) Run dev server
```bash
npm run dev
```

Health check:
- GET /health

---

## Auth model

### Login (used by NextAuth Credentials)
`POST /api/staff/login`
Body:
```json
{ "email": "name@mld.com", "password": "..." }
```
Returns:
```json
{
  "token": "...",
  "user": { "id": "...", "email": "...", "role": "ADMIN|STAFF", "locationAccess": ["slc-hq","slc-outlet"], "mustChangePassword": true }
}
```

Send token on protected routes:
`Authorization: Bearer <token>`

### Change password (requires current password)
`POST /api/staff/change-password`
Body:
```json
{ "currentPassword": "...", "newPassword": "..." }
```
Rules: 8+ chars, 1 number, 1 symbol.

### Forgot password (email reset link)
`POST /api/auth/forgot-password`
Body:
```json
{ "email": "name@mld.com" }
```
Emails a link:
`{FRONTEND_URL}/staff/reset-password?token=...`

### Reset password (from emailed token)
`POST /api/auth/reset-password`
Body:
```json
{ "token": "...", "newPassword": "..." }
```
Token expires in 1 hour; after reset, `mustChangePassword` becomes false.

---

## Admin-only staff user management

All routes under `/api/staff/users/*` require an ADMIN token.

- `GET /api/staff/users`
- `POST /api/staff/users` -> returns `tempPassword` (for you to email manually)
- `GET /api/staff/users/:id`
- `PATCH /api/staff/users/:id`

Location IDs allowed: `slc-hq`, `slc-outlet`, `boise-willcall`

---

## Pickups (staff + admin)

All routes under `/api/staff/pickups/*` require auth token.

- `GET /api/staff/pickups?locationId=slc-hq&status=Scheduled`
- `GET /api/staff/pickups/:id`
- `PATCH /api/staff/pickups/:id` (status/startAt/endAt)

Staff are automatically scoped to `locationAccess`.
Admins can access all.
