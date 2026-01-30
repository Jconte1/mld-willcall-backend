export type PickupLocation = {
  id: string;
  name: string;
  address: string;
  instructions?: string;
};

const LOCATIONS: PickupLocation[] = [
  {
    id: "slc-hq",
    name: "SALT LAKE HQ",
    address: "5167 W 1730 S, Salt Lake City, UT 84104",
    instructions: "Entrance is in the NorthEast corner of the building. Our team will assist you with loading.",
  },
  {
    id: "slc-outlet",
    name: "SALT LAKE OUTLET",
    address: "2345 S. Main Street, Salt Lake City, UT 84115",
    instructions: "Check in at the front desk when you arrive. Our team will assist you with loading.",
  },
  {
    id: "boise-willcall",
    name: "BOISE WILL CALL",
    address: "627 N. Dupont Ave. Boise, ID 83713",
    instructions: "Check in at the front desk when you arrive. Our team will assist you with loading.",
  },
];

export function getPickupLocation(locationId: string | null | undefined) {
  if (!locationId) return undefined;
  return LOCATIONS.find((loc) => loc.id === locationId);
}
