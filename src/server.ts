import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { authRouter } from "./routes/auth";
import { staffAuthRouter } from "./routes/staffAuth";
import { customerAuthRouter } from "./routes/customerAuth";
import { customerOrdersRouter } from "./routes/customerOrders";
import { customerPickupsRouter } from "./routes/customerPickups";
import { staffUsersRouter } from "./routes/staffUsers";
import { pickupsRouter } from "./routes/pickups";
import { acumaticaRouter } from "./routes/acumatica";
import { publicAppointmentsRouter } from "./routes/publicAppointments";
import { publicOrderReadyRouter } from "./routes/publicOrderReady";

const app = express();

const frontend = process.env.FRONTEND_URL ?? "https://mld-willcall.vercel.app";

app.use(helmet());
app.use(cors({
  origin: frontend,
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Auth (password reset)
app.use("/api/auth", authRouter);

// Staff auth
app.use("/api/staff", staffAuthRouter);

// Customer auth
app.use("/api/customer", customerAuthRouter);

// Customer orders
app.use("/api/customer/orders", customerOrdersRouter);

// Customer pickups
app.use("/api/customer/pickups", customerPickupsRouter);

// Public appointments (secure link)
app.use("/api/public/appointments", publicAppointmentsRouter);

// Public order-ready (secure link)
app.use("/api/public/order-ready", publicOrderReadyRouter);

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
