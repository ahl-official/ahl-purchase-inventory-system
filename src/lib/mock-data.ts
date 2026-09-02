/**
 * Master data mirrored from the AHL Flow DB spreadsheet.
 *
 * These IDs are real — every value here exists in the PRODUCTS, LISTS and PEOPLE
 * tabs, so a payload built from them resolves on the backend. This file is a
 * stopgap until a read-sync endpoint serves the same tabs live; when that lands,
 * delete it rather than letting the two drift.
 *
 * Rule from the project brief: master data is never a free-text input. Every
 * value below backs a <select>.
 */

/** Mirrors PRODUCTS.ProductType. Drives the Product Type → Name cascade on the request form. */
export type ProductType = "Retail" | "Consumable" | "Furniture";

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  productType: ProductType;
  /** Unit stock is issued in. Receipts arrive in a purchase unit and convert. */
  uom: string;
  cost: number;
  reorderLevel: number;
  /**
   * On-hand quantity. null until a read-sync exists — the ledger is the only
   * authority, and showing an invented number is worse than showing none.
   */
  balance: number | null;
}

export const MOCK_PRODUCTS: Product[] = [
  { id: "PRD-0001", name: "Custom Hair Patch - Grade A", categoryId: "CAT-01", productType: "Retail", uom: "PCS", cost: 8500, reorderLevel: 5, balance: null },
  { id: "PRD-0002", name: "Custom Hair Patch - Grade B", categoryId: "CAT-01", productType: "Retail", uom: "PCS", cost: 5500, reorderLevel: 5, balance: null },
  { id: "PRD-0003", name: "Hair Topper - Standard", categoryId: "CAT-01", productType: "Retail", uom: "PCS", cost: 6000, reorderLevel: 3, balance: null },
  { id: "PRD-0004", name: "Blue Tape", categoryId: "CAT-02", productType: "Consumable", uom: "PCS", cost: 85, reorderLevel: 50, balance: null },
  { id: "PRD-0005", name: "Scalp Protector Spray", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 12.5, reorderLevel: 100, balance: null },
  { id: "PRD-0006", name: "Glue Hold", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 27.72, reorderLevel: 10, balance: null },
  { id: "PRD-0007", name: "No Shine C Tape", categoryId: "CAT-02", productType: "Consumable", uom: "PCS", cost: 12.5, reorderLevel: 10, balance: null },
  { id: "PRD-0008", name: "C-22 Solvent 118ml", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 5.51, reorderLevel: 5, balance: null },
  { id: "PRD-0009", name: "C-22 Solvent 5000ml", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 2.1, reorderLevel: 50, balance: null },
  { id: "PRD-0010", name: "Lace Front Tape", categoryId: "CAT-02", productType: "Consumable", uom: "PCS", cost: 3.78, reorderLevel: 5, balance: null },
  { id: "PRD-0011", name: "German White Tape", categoryId: "CAT-02", productType: "Consumable", uom: "PCS", cost: 2.08, reorderLevel: 10, balance: null },
  { id: "PRD-0012", name: "Hard Spray", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 1.9, reorderLevel: 10, balance: null },
  { id: "PRD-0013", name: "Shine Spray", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 3.33, reorderLevel: 10, balance: null },
  { id: "PRD-0014", name: "Beard Softener", categoryId: "CAT-02", productType: "Consumable", uom: "GM", cost: 4.5, reorderLevel: 5, balance: null },
  { id: "PRD-0015", name: "Aloe Vera Gel", categoryId: "CAT-02", productType: "Consumable", uom: "GM", cost: 0.25, reorderLevel: 5, balance: null },
  { id: "PRD-0016", name: "Cotton", categoryId: "CAT-02", productType: "Consumable", uom: "GM", cost: 0.45, reorderLevel: 8, balance: null },
  { id: "PRD-0017", name: "Oil", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 0.37, reorderLevel: 5, balance: null },
  { id: "PRD-0018", name: "Beard Shaping Gel", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 1.25, reorderLevel: 5, balance: null },
  { id: "PRD-0019", name: "After Shave", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 4, reorderLevel: 5, balance: null },
  { id: "PRD-0020", name: "Shampoo", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 0, reorderLevel: 1000, balance: null },
  { id: "PRD-0021", name: "Conditioner", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 0, reorderLevel: 1000, balance: null },
  { id: "PRD-0022", name: "Macadamia Oil Shampoo", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 0, reorderLevel: 1000, balance: null },
  { id: "PRD-0023", name: "Macadamia Oil Conditioner", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 0, reorderLevel: 1000, balance: null },
  { id: "PRD-0024", name: "Argan Oil Shampoo", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 0, reorderLevel: 1000, balance: null },
  { id: "PRD-0025", name: "Argan Oil Conditioner", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 0, reorderLevel: 1000, balance: null },
  { id: "PRD-0026", name: "Colour Tube 100ml", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 1, reorderLevel: 50, balance: null },
  { id: "PRD-0027", name: "Developer", categoryId: "CAT-09", productType: "Consumable", uom: "ML", cost: 0, reorderLevel: 20, balance: null },
  { id: "PRD-0028", name: "Kerastase Shampoo 250ml", categoryId: "CAT-08", productType: "Retail", uom: "BTL", cost: 850, reorderLevel: 10, balance: null },
  { id: "PRD-0029", name: "Kerastase Conditioner 200ml", categoryId: "CAT-08", productType: "Retail", uom: "BTL", cost: 750, reorderLevel: 10, balance: null },
  { id: "PRD-0030", name: "Moroccan Oil Serum 100ml", categoryId: "CAT-08", productType: "Retail", uom: "BTL", cost: 1200, reorderLevel: 5, balance: null },
  { id: "PRD-0031", name: "Tape Roll - Extension", categoryId: "CAT-06", productType: "Consumable", uom: "ROLL", cost: 15, reorderLevel: 50, balance: null },
  { id: "PRD-0032", name: "Bonding Solution 500ml", categoryId: "CAT-02", productType: "Consumable", uom: "ML", cost: 1.2, reorderLevel: 10, balance: null },
  { id: "PRD-0033", name: "SMP Pigment - Black", categoryId: "CAT-04", productType: "Consumable", uom: "ML", cost: 45, reorderLevel: 10, balance: null },
];

/**
 * Local-only stock used to demonstrate Hitesh's workflow while the Apps Script
 * deployment is unavailable. These values are never posted to Google Sheets.
 * A successful live refresh replaces them with ledger balances.
 */
export const DEMO_STOCK_BALANCES: Record<string, number> = {
  "PRD-0001": 12,
  "PRD-0002": 7,
  "PRD-0003": 4,
  "PRD-0004": 120,
  "PRD-0005": 450,
  "PRD-0006": 180,
  "PRD-0008": 350,
  "PRD-0009": 3500,
  "PRD-0015": 500,
  "PRD-0026": 800,
  "PRD-0028": 14,
  "PRD-0031": 60,
  "PRD-0033": 24,
};

export const PRODUCT_TYPES: { id: ProductType; label: string }[] = [
  { id: "Retail", label: "Retail product" },
  { id: "Consumable", label: "Consumable product" },
  { id: "Furniture", label: "Furniture" },
];

/**
 * `dot` maps each category onto a chart token from globals.css rather than a raw
 * Tailwind colour, so category identity stays inside the design system.
 * `unit` is the business the cost lands on — the axis Category P&L reports on.
 */
export const MOCK_CATEGORIES = [
  { id: "CAT-01", name: "Hair Systems", unit: "AHL", dot: "bg-chart-1" },
  { id: "CAT-02", name: "AHL Service", unit: "AHL", dot: "bg-chart-1" },
  { id: "CAT-03", name: "Refilling System", unit: "AHL", dot: "bg-chart-1" },
  { id: "CAT-04", name: "SMP", unit: "AHL", dot: "bg-chart-1" },
  { id: "CAT-05", name: "AHL Membership", unit: "AHL", dot: "bg-chart-1" },
  { id: "CAT-06", name: "Hair Extensions", unit: "Alchemane", dot: "bg-chart-4" },
  { id: "CAT-07", name: "Alchemane Service", unit: "Alchemane", dot: "bg-chart-4" },
  { id: "CAT-08", name: "Alchemane Retail", unit: "Alchemane", dot: "bg-chart-4" },
  { id: "CAT-09", name: "Salon", unit: "Shared", dot: "bg-chart-2" },
  { id: "CAT-10", name: "Skin", unit: "Shared", dot: "bg-chart-2" },
  { id: "CAT-11", name: "Microblading", unit: "Shared", dot: "bg-chart-2" },
  { id: "CAT-12", name: "Consultation", unit: "Shared", dot: "bg-chart-2" },
  { id: "CAT-13", name: "AMC", unit: "Shared", dot: "bg-chart-2" },
  { id: "CAT-14", name: "Package & Membership", unit: "Shared", dot: "bg-chart-2" },
  { id: "CAT-15", name: "Back Office", unit: "Shared", dot: "bg-chart-3" },
  { id: "CAT-16", name: "Unallocated", unit: "", dot: "bg-chart-5" },
];

/** People stock can be issued to. Mirrors the PEOPLE tab. */
export const MOCK_USERS = [
  { id: "USR-005", name: "Satvik", role: "Purchase" },
  { id: "USR-006", name: "Hitesh", role: "Distribution" },
  { id: "USR-007", name: "Sushmita", role: "Distribution" },
  { id: "USR-011", name: "Daisy", role: "Floor" },
  { id: "USR-012", name: "Gauri", role: "Floor" },
  { id: "USR-013", name: "Anita", role: "Floor" },
  { id: "USR-014", name: "Nincy", role: "Floor" },
  { id: "USR-015", name: "Tuba", role: "Floor" },
  { id: "USR-016", name: "Pooja", role: "Floor" },
  { id: "USR-017", name: "Bunu", role: "Floor" },
  // Sign off requests over the approval threshold. Not app logins — just the
  // two names Satvik is allowed to record as having said yes. Add their real
  // UserIDs to PEOPLE once this is decided for real; these are placeholders.
  { id: "USR-018", name: "Jagruti Mam", role: "Approver" },
  { id: "USR-019", name: "Vishal Sir", role: "Approver" },
];

export const MOCK_APPROVERS = MOCK_USERS.filter((u) => u.role === "Approver");

export const MOCK_LOCATIONS = [
  { id: "LOC-01", name: "HO Mumbai" },
  { id: "LOC-02", name: "Khar Studio" },
  { id: "LOC-03", name: "Delhi Studio" },
  { id: "LOC-04", name: "Bangalore Studio" },
  { id: "LOC-05", name: "In Transit" },
  { id: "LOC-06", name: "China WIP" },
  { id: "LOC-07", name: "Receiving (Satvik)" },
];

/** Where stock is issued from unless the user picks otherwise. */
export const DEFAULT_LOCATION_ID = "LOC-01";

export const MOCK_VENDORS = [
  { id: "VND-01", name: "HairTech India", city: "Mumbai" },
  { id: "VND-02", name: "Khimaj Hair", city: "Mumbai" },
  { id: "VND-03", name: "Shine Hair Co.", city: "China" },
  { id: "VND-04", name: "New Beauty Point", city: "Mumbai" },
  { id: "VND-05", name: "SMP Supplier", city: "Delhi" },
  { id: "VND-06", name: "Local Vendor", city: "Mumbai" },
  { id: "VND-07", name: "Distributor", city: "Mumbai" },
  { id: "VND-08", name: "Emida", city: "China" },
  { id: "VND-09", name: "Vaspan Enterprises", city: "Mumbai" },
  { id: "VND-10", name: "Aesthetic Solutions", city: "Mumbai" },
  { id: "VND-11", name: "Nancy", city: "Mumbai" },
  { id: "VND-12", name: "Amy / HN", city: "China" },
];
