import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { authRouter } from "./routes/auth";
import { staffAuthRouter } from "./routes/staffAuth";
import { staffProfileRouter } from "./routes/staffProfile";
import { customerAuthRouter } from "./routes/customerAuth";
import { customerOrdersRouter } from "./routes/customerOrders";
import { customerSyncRouter } from "./routes/customerSync";
import { customerPickupsRouter } from "./routes/customerPickups";
import { customerInvitesRouter } from "./routes/customerInvites";
import { internalInvitesRouter } from "./routes/internalInvites";
import { staffUsersRouter } from "./routes/staffUsers";
import { pickupsRouter } from "./routes/pickups";
import { acumaticaRouter } from "./routes/acumatica";
import { publicAppointmentsRouter } from "./routes/publicAppointments";
import { publicOrderReadyRouter } from "./routes/publicOrderReady";
import { twilioInboundRouter } from "./routes/twilioInbound";

const app = express();

const frontend = process.env.FRONTEND_URL ?? "https://mld-willcall.vercel.app";

app.use(helmet());
app.use(cors({
  origin: frontend,
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Auth (password reset)
app.use("/api/auth", authRouter);

// Staff auth
app.use("/api/staff", staffAuthRouter);
// Staff profile
app.use("/api/staff/profile", staffProfileRouter);

// Customer auth
app.use("/api/customer", customerAuthRouter);

// Customer orders
app.use("/api/customer/orders", customerOrdersRouter);

// Customer sync
app.use("/api/customer/sync", customerSyncRouter);

// Customer pickups
app.use("/api/customer/pickups", customerPickupsRouter);

// Customer invites + members
app.use("/api/customer/invites", customerInvitesRouter);

// Internal invites (server-to-server)
app.use("/api/internal/invites", internalInvitesRouter);

// Public appointments (secure link)
app.use("/api/public/appointments", publicAppointmentsRouter);

// Public order-ready (secure link)
app.use("/api/public/order-ready", publicOrderReadyRouter);

// Twilio inbound SMS webhook
app.use("/api/twilio", twilioInboundRouter);

// Admin user management
app.use("/api/staff/users", staffUsersRouter);

// Pickups
app.use("/api/staff/pickups", pickupsRouter);

// Acumatica
app.use("/api/acumatica", acumaticaRouter);

app.use((req, res) => {
  res.status(404).json({ message: "Not found" });
});

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? "5000");
  app.listen(port, () => {
    console.log(`mld-willcall-backend listening on :${port}`);
  });
}
