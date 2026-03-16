type Input = {
  orderNbr: string;
  buyerGroup?: string | null;
  customerLocationId?: string | null;
  customerIdDescription?: string | null;
  jobDisplay?: string | null;
};

const GENERIC_CUSTOMER_LOCATION_IDS = new Set(["MAIN"]);

function cleaned(value: string | null | undefined) {
  const text = String(value || "").trim();
  return text || null;
}

function resolveCustomerLabel(input: Input) {
  const location = cleaned(input.customerLocationId);
  if (location && !GENERIC_CUSTOMER_LOCATION_IDS.has(location.toUpperCase())) {
    return location;
  }
  return cleaned(input.customerIdDescription);
}

export function buildOrderNotificationLabel(input: Input) {
  const orderNbr = cleaned(input.orderNbr) || "";
  const buyerGroup = cleaned(input.buyerGroup);
  const customerLabel = resolveCustomerLabel(input);
  const jobDisplay = cleaned(input.jobDisplay);

  let label = buyerGroup ? `${buyerGroup} Order ${orderNbr}` : `Order ${orderNbr}`;
  if (customerLabel) {
    label += ` for ${customerLabel}`;
  } else if (jobDisplay) {
    label += ` - ${jobDisplay}`;
  }
  return label;
}

