import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Set body parsers with a higher payload limit for uploading PDFs
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ---------------------------------------------------------------------------
// Anthropic configuration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-opus-5";

// Tried in order if the primary model is overloaded or rate limited.
const FALLBACK_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"];

const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof VALID_EFFORTS)[number];

// The Anthropic API rejects requests larger than 32MB.
const MAX_PDF_BYTES = 30 * 1024 * 1024;

interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  workspaceId?: string;
  effort: Effort;
}

const clean = (value: string | undefined) =>
  (value || "").trim().replace(/^["']|["']$/g, "").trim();

// Read configuration from the environment on every request so a changed .env
// takes effect without a restart in dev.
const getAnthropicConfig = (): AnthropicConfig => {
  const effort = clean(process.env.ANTHROPIC_EFFORT).toLowerCase();
  return {
    apiKey: clean(process.env.ANTHROPIC_API_KEY),
    model: clean(process.env.ANTHROPIC_MODEL) || DEFAULT_MODEL,
    baseURL: clean(process.env.ANTHROPIC_BASE_URL) || undefined,
    // Org-level keys are not tied to a workspace and must name one per request.
    // Keys created inside a workspace carry it already and need nothing here.
    workspaceId: clean(process.env.ANTHROPIC_WORKSPACE_ID) || undefined,
    effort: (VALID_EFFORTS as readonly string[]).includes(effort)
      ? (effort as Effort)
      : "medium",
  };
};

let cachedClient: { key: string; client: Anthropic } | null = null;

const getAnthropicClient = (config: AnthropicConfig): Anthropic => {
  const cacheKey = `${config.apiKey}::${config.baseURL || ""}::${config.workspaceId || ""}`;
  if (cachedClient && cachedClient.key === cacheKey) return cachedClient.client;

  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.workspaceId
      ? { defaultHeaders: { "anthropic-workspace-id": config.workspaceId } }
      : {}),
    // Extraction with reasoning can take a while on a dense multi-page invoice.
    timeout: 120_000,
    maxRetries: 2,
  });

  cachedClient = { key: cacheKey, client };
  return client;
};

// JSON schema the model must conform to. `responsible`, `name`, and `wo` are
// deliberately absent - they are always forced to null after extraction.
const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    isTruckInvoice: {
      type: "boolean",
      description:
        "True if the invoice covers repairs on a heavy-duty commercial truck (Freightliner, Peterbilt, Volvo, Kenworth, International, Western Star, Mack, Hino).",
    },
    detectedBrand: {
      type: ["string", "null"],
      description:
        "Detected truck brand in caps (FREIGHTLINER, PETERBILT, VOLVO, KENWORTH, INTERNATIONAL, MACK, WESTERN STAR, HINO), 'Other', or null.",
    },
    reasons: {
      type: "string",
      description:
        "One short sentence on how the brand was verified, or why the invoice was rejected.",
    },
    items: {
      type: "array",
      description:
        "Extracted service line items - typically one row summarizing the truck portion of the invoice.",
      items: {
        type: "object",
        properties: {
          num: { type: "integer", description: "Row index starting at 1" },
          invoice: { type: "string", description: "Invoice digits only" },
          date: { type: "string", description: "Invoice date as MM/DD/YYYY" },
          unit: { type: "string", description: "Truck or unit number" },
          cost: { type: "number", description: "Total cost of the truck repairs" },
          note: { type: "string", description: "Short keyword summary of work done" },
        },
        required: ["num", "invoice", "date", "unit", "cost", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["isTruckInvoice", "detectedBrand", "reasons", "items"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a strict and highly precise data extraction specialist verifying and converting truck repair invoices for a commercial logistics trucking company.

Your PRIMARY task is to identify and extract repair data ONLY for heavy-duty commercial trucks (e.g. FREIGHTLINER, PETERBILT, VOLVO, KENWORTH, INTERNATIONAL, MACK, HINO, WESTERN STAR).
- Use these reputable commercial truck makes as your ORIENTATION/GUIDELINE to identify the TRUCK portion of the repairs.
- STRICTLY EXCLUDE AND IGNORE TRAILER REPAIRS: repairs for trailers (e.g., dry vans, flatbeds, reefers, chassis) and specific trailer brands (e.g., WABASH, GREAT DANE, UTILITY, VANGUARD, CIMC, STOUGHTON) or trailer-associated units (often starting with "T", such as "T123", or explicitly named "Trailer") must be COMPLETELY EXCLUDED.
- DO NOT create any output items/rows for trailer repairs.
- If a PDF invoice contains a combination of truck repairs and trailer repairs, extract data ONLY for the truck portion. Ignore the trailer sections entirely and do not include their cost or details.

CRITICAL Truck Verification Rules:
1. isTruckInvoice: Evaluate if the invoice contains heavy-duty commercial TRUCK repairs, mentioning brands like FREIGHTLINER, PETERBILT, VOLVO, KENWORTH, INTERNATIONAL, MACK, HINO, WESTERN STAR, etc. If it is ONLY trailer repairs, or other non-truck utilities, set isTruckInvoice to false.
2. detectedBrand: Capture the specific truck brand name in all caps (e.g., "FREIGHTLINER", "PETERBILT", "VOLVO", "KENWORTH", "INTERNATIONAL", "MACK", "HINO", "WESTERN STAR"). If some other brand, write "Other". If none, write null.
3. reasons: Briefly state (1 sentence) how you determined the brand or why it was rejected.

EXTRACTION RULES FOR TRUCK AND INVOICE NUMBERS (EXTREMELY IMPORTANT TO PREVENT COMMON ERRORS):
- **invoice** (Invoice Number): 
  * You MUST locate the master commercial Invoice Number of the document.
  * It is usually located at the very top, top-right, or top-left of the page, preceded by labels like "Invoice No.", "Invoice #", "Inv No.", "Bill No.", "Document #", etc.
  * STRICT EXCLUSION: Never use Customer ID, Account Number, Phone Number, Tax ID, Store Number, Part Number, Purchase Order (PO) Number, or Odometer reading.
  * Alphanumeric format is fine, but strip prefix/suffix labels like "INV-". For example, extract "8402" instead of "INV-8402".

- **unit** (Truck Unit Number): 
  * You MUST locate the exact commercial Truck/Tractor unit number.
  * It is typically 3 to 6 digits (e.g. 115, 208, 311, 402, 1052).
  * Look for labels like "Truck #", "Unit #", "Tractor", "Tractor #", "Tractor No.", "Vehicle ID", "Unit No.", "Truck No.", or "Vehicle #", especially near the truck brand (e.g., Freightliner Unit 311).
  * STRICT EXCLUSION: Never extract a 17-character VIN number, license plate, mileage/odometer, purchase order number, parts catalog number, or trailer numbers (which often start with "T", "TR", or are listed under a separate trailer section).

Extraction fields for each item in the "items" array:
- num: sequential row number starting at 1 (integer)
- invoice: invoice number digits ONLY (string)
- date: service date MM/DD/YYYY (string)
- unit: unit number of the TRUCK only (no "#" symbol) (string). Use the truck makes (Freightliner/Volvo/Peterbilt/etc.) as reference landmarks to find the correct TRUCK Unit Number. Absolutely do not put trailer unit numbers here.
- responsible: null
- name: null
- cost: Total cost associated with the TRUCK repairs ONLY as number, no $ sign (number). If the invoice separates costs, calculate/subtotal the truck portion specifically. If it is integrated, provide the total cost belonging strictly to the truck portion.
- note: SHORT keyword-style summary of ALL TRUCK work done across service sections. Max 12 keywords/phrases separated by commas. Use trucking abbreviations: PM, DOT, CTC, CEL, RR, LH, RH, Q-FENDER, ALIGNMENT, TIRE INSTALL. Example styles: "PM, DOT, ALIGNMENT, CTC" / "RH HOOD FENDER, INSID BUMPER, STEP FAIRING, TIRE INSTALL (2)" / "REPAIR CORNER RAIL AND NOISE". Absolutely do NOT include trailer-related repairs (like "trailer roof", "trailer door", "trailer tandem", "brakes on trailer") in this note.
- wo: null

CRITICAL rules for "note":
- SHORT and KEYWORD-BASED — like a dispatch shorthand note
- NO part names (such as gasket, seal, washer, bolt, nut, clamp, grease, oil, filter, plug, hose, valve, bulb - EXCEPT critical engine or emissions diagnostics and parts like NOX SENSOR), NO prices, NO full sentences
- Combine ALL truck-related service sections into ONE brief note
- NEVER include trailer repair keywords or trailer details
- Use standard caps abbreviations as shown in examples
- BUMPER REINFORCEMENT AND COVER RULES: If repair services or parts include "bumper reinforcement" (or bumper reinf), you MUST extract it specifically as "INSID BUMPER". If it is "bumper cover" (or bumper fascia), write it as "BUMPER COVER". Never use "BUMPER" if these specific components are identified.
- PM SERVICE LOGIC RULE: If the invoice contains a PM (Preventive Maintenance) service or routine oil/filter change service, be logic-bounded and keep the note short and clean: output "PM SERVICE". Completely OMIT and filter out routine individual components like "oil filter", "fuel filter", "water separator", "lube", "engine oil", "filters", or "grease" when PM is listed, because they are already part of the PM service. However, do NOT omit or filter out distinct major repair services like "NOX SENSOR" repair/diagnose, brakes, alignment, or tire replacement, even if they are listed within the PM service section.
- TIRE REPLACEMENT RULE: If there is a tire replacement or tire installation service, you MUST look closely at the parts/tire descriptions of the invoice. If only steer tires are replaced/installed, write "STEER TIRE REPLACE". If only drive/driver tires are replaced/installed, write "DRIVE TIRE REPLACE". If both steer and drive tires are replaced/installed, write "STEER & DRIVE TIRE REPLACE". Avoid using a generic "TIRE INSTALL" if steer or drive details can be determined.
- L1 BRACKET RULE: If the invoice explicitly mentions "L1 Bracket", "REPAIR L1 BRACKET", "L1", or "L!" in relation to bracket repair, you MUST write "L1 BRACKET" in the notes. Do not simplify it to "CAB REPAIR" or generic "BRACKET". Only write "L1 BRACKET" if you actually see "L1" or "L!" or "L1 Bracket" in the invoice text.
- NOX SENSOR RULE: If the invoice explicitly mentions "NOX SENSOR", "NOX SENSORS", "NOX SENSOR NITROGEN OXIDE", "DIAGNOSE AND REPLACE BOTH NOX SENSOR", or "NOX", you MUST write "NOX SENSOR" in the notes. Do not omit or filter it out under any other rules.

Return ONLY the JSON. No markdown decoration, no explanation.`;

const cleanJSONResponse = (text: string): string => {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "");
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.replace(/\n?```$/i, "");
  }
  return cleaned.trim();
};

function checkShouldSkipInvoice(text: string): { shouldSkip: boolean; reason: string } {
  if (!text) return { shouldSkip: false, reason: "" };

  const upperText = text.toUpperCase();

  // Extract parts/services search indicators
  const hasNexusLane = upperText.includes("NEXUS LANE");
  const hasSOPrefix = /SO-\d{5,12}/.test(upperText) || /\bSO-00\d+/.test(upperText) || upperText.includes("SO-00");

  // General repair indicators - if these are present, we should NOT skip because it contains repair work!
  const hasRepairServices = 
    upperText.includes("REPAIR") || 
    upperText.includes("SERVICE") || 
    upperText.includes("MAINTENANCE") || 
    upperText.includes("LABOR") || 
    upperText.includes("BRAKE") || 
    upperText.includes("TIRE") || 
    upperText.includes("COOLANT") || 
    upperText.includes("BUMPER") ||
    upperText.includes("ALIGNMENT") ||
    upperText.includes("PM ") ||
    upperText.includes("DOT ") ||
    upperText.includes("PREVENTATIVE") ||
    upperText.includes("PREVENTIVE") ||
    upperText.includes("NOX");

  if (hasNexusLane) {
    if (hasSOPrefix && !hasRepairServices) {
      return {
        shouldSkip: true,
        reason: "Non-repair sales order invoice from Nexus Lane LLC skipped."
      };
    }
    if (upperText.includes("DIESEL") && !hasRepairServices) {
      return {
        shouldSkip: true,
        reason: "Non-repair diesel purchase from Nexus Lane LLC skipped."
      };
    }
  }

  // Pure diesel receipts without repair indicators
  const isPureDiesel = upperText.includes("DIESEL") && !hasRepairServices;
  if (isPureDiesel && !upperText.includes("FREIGHTLINER") && !upperText.includes("VOLVO") && !upperText.includes("PETERBILT")) {
    return {
      shouldSkip: true,
      reason: "Pure diesel/fuel purchase receipt without repair services skipped."
    };
  }

  // Non-repair Sales Orders
  if (hasSOPrefix && !hasRepairServices && !upperText.includes("FREIGHTLINER") && !upperText.includes("VOLVO") && !upperText.includes("PETERBILT")) {
    return {
      shouldSkip: true,
      reason: "Sales Order (SO- prefix) non-repair invoice skipped."
    };
  }

  return { shouldSkip: false, reason: "" };
}

// Clean, logical, and short note simplified mapping
function cleanAndSimplifyNote(rawNote: string): string {
  if (!rawNote) return "TRUCK SERVICE REPAIR";

  // First, split key items by comma or semicolon
  let items = rawNote
    .split(/[,;]+/)
    .map(p => p.toUpperCase().replace(/[^A-Z0-9 &\-,]/g, "").trim())
    .filter(Boolean);

  // Normalize PM names, Bumper names, Brakes names, and check for PM indicators
  let hasPM = false;
  let pmIndicatorCount = 0;

  const pmKeywords = [
    "PM", "PM SERVICE", "PREVENTATIVE MAINTENANCE", "PREVENTIVE MAINTENANCE", 
    "LUBE OIL FILTER", "OIL CHANGE", "LOF", "CHASSIS LUBE", "CHASSIS SERVICE",
    "A SERVICE", "B SERVICE"
  ];

  const pmIndicatorsList = [
    "OIL FILTER", "OIL FILTERS", "FUEL FILTER", "FUEL FILTERS", "FILTERS", "FILTER",
    "CABIN FILTER", "AIR FILTER", "WATER SEPARATOR FILTER", "WATER SEPARATOR",
    "ENGINE OIL", "MOTOR OIL", "LUBE", "GREASE", "SEPARATOR", "SEPARATORS"
  ];

  for (const item of items) {
    if (pmKeywords.includes(item)) {
      hasPM = true;
    }
    // Substring or pattern checks
    if (item.includes("PM") && !item.includes("BUMPER") && !item.includes("TEMP")) {
      hasPM = true;
    }
    if (item.includes("PREVENTATIVE") || item.includes("PREVENTIVE")) {
      hasPM = true;
    }
    if (pmIndicatorsList.includes(item)) {
      pmIndicatorCount++;
    }
  }

  // If we have PM keyword, or 2 or more PM indicators, it is a PM Service offline.
  if (pmIndicatorCount >= 1 && items.length <= 3 && !hasPM) {
    hasPM = true;
  } else if (pmIndicatorCount >= 2) {
    hasPM = true;
  }

  let processed: string[] = [];

  for (let item of items) {
    // Skip general dummy text
    if (item === "TRUCK SERVICE REPAIR" || item === "SERVICE" || item === "REPAIR" || item === "PARTS" || item === "PART") {
      continue;
    }

    // 1. Simplify PM to PM SERVICE
    if (pmKeywords.includes(item) || (item.includes("PM") && !item.includes("BUMPER") && !item.includes("TEMP")) || item.includes("PREVENTATIVE") || item.includes("PREVENTIVE")) {
      processed.push("PM SERVICE");
      continue;
    }

    // 2. Simplify Bumper reinforcement/cover per user specification:
    // "if in the invoice will be bumper reinforsement in have to write it like insid bumper"
    if (item.includes("BUMPER")) {
      if (item.includes("REINFORCEMENT") || item.includes("REINF")) {
        processed.push("INSID BUMPER");
        continue;
      }
      if (item.includes("COVER") || item.includes("FASCIA")) {
        processed.push("BUMPER COVER");
        continue;
      }
      // General item check
      processed.push("BUMPER");
      continue;
    }

    if (item.includes("REINFORCEMENT") || item === "REINF") {
      processed.push("INSID BUMPER");
      continue;
    }

    // 3. Simplify BRAKES
    if (item.includes("BRAKE") || item === "ROTORS" || item === "CALIPER" || item === "CALIPERS") {
      processed.push("BRAKES");
      continue;
    }

    // 4. Simplify TIRE
    if (item.includes("TIRE") || item === "WHEEL" || item === "WHEELS") {
      const hasSteer = item.includes("STEER");
      const hasDrive = item.includes("DRIVE") || item.includes("DRIVER");
      if (hasSteer && hasDrive) {
        processed.push("STEER & DRIVE TIRE REPLACE");
      } else if (hasSteer) {
        processed.push("STEER TIRE REPLACE");
      } else if (hasDrive) {
        processed.push("DRIVE TIRE REPLACE");
      } else {
        processed.push("TIRE INSTALL");
      }
      continue;
    }

    // 5. Simplify WIPERS
    if (item.includes("WIPER")) {
      processed.push("WIPERS");
      continue;
    }

    // 6. Simplify COOLANT
    if (item.includes("COOLANT") || item === "ANTIFREEZE") {
      processed.push("COOLANT LEAK");
      continue;
    }

    // 7. Simplify A/C
    if (item.includes("A/C") || item.includes("AIR CONDITIONING") || item === "FREON") {
      processed.push("A/C SERVICE");
      continue;
    }

    // 8. Simplify MIRROR
    if (item.includes("MIRROR")) {
      processed.push("MIRROR");
      continue;
    }

    // 9. Simplify L1 BRACKET (handle potential OCR/typo variations like L! or L1)
    if (
      item.includes("L1") || 
      item.includes("L!") || 
      (item.includes("CAB") && (item.includes("L1") || item.includes("L!"))) ||
      (item.includes("BRACKET") && (item.includes("L1") || item.includes("L!")))
    ) {
      processed.push("L1 BRACKET");
      continue;
    }

    // 10. Simplify NOx SENSOR (handle potential OCR/variations like NOX, N0X, NOX SENSOR)
    if (item.includes("NOX") || item.includes("N0X")) {
      processed.push("NOX SENSOR");
      continue;
    }

    // Otherwise keep the item
    processed.push(item);
  }

  // If PM is active, make sure "PM SERVICE" is listed and filter out all PM indicators (oil filters, fuel filters, water separators, lube, oil, grease, engine oil, etc.)
  if (hasPM) {
    processed.push("PM SERVICE");
    processed = processed.filter(p => {
      if (p === "PM SERVICE") return true;
      if (p === "PM") return false;

      const upperP = p.toUpperCase();
      // Check if it is exactly one of the indicators
      if (pmIndicatorsList.includes(upperP)) return false;

      // Discard any item that contains filter/oil/separator/lube/grease as part of it
      const words = upperP.split(/\s+/);
      if (words.includes("FILTER") || words.includes("FILTERS") || words.includes("OIL") || words.includes("LUBE") || words.includes("GREASE") || words.includes("SEPARATOR") || words.includes("SEPARATORS")) {
        return false;
      }
      return true;
    });
  }

  // Deduplicate and filter out standalone pure parts names that clog up notes
  const discardParts = new Set([
    "FILTER", "FILTERS", "OIL FILTER", "OIL FILTERS", "FUEL FILTER", "FUEL FILTERS", "CABIN FILTER", "AIR FILTER", "WATER SEPARATOR FILTER", "WATER SEPARATOR",
    "GASKET", "GASKETS", "SEAL", "SEALS", "O-RING", "O-RINGS", "WASHER", "WASHERS", "NUT", "NUTS", "BOLT", "BOLTS", "SCREW", "SCREWS", "CLAMP", "CLAMPS", "GROMMET", "PLUG", "PLUGS", "BRACKET", "BRACKETS", "COLLAR", "SLEEVE", "BUSHING", "BUSHINGS", "SHIM", "SHIMS", "PIN", "PINS", "CLIP", "CLIPS", "SPRING", "SPRINGS", "STRAP", "STRAPS", "TIE", "TIES", "ADAPTER", "FLUID", "FLUIDS", "LUBE", "GREASE", "OIL", "ENGINE OIL", "MOTOR OIL", "COOLANT", "ANTIFREEZE", "FREON", "REFRIGERANT", "HOSE", "HOSES", "TUBE", "TUBES", "PIPE", "PIPES", "FITTING", "FITTINGS", "CONNECTOR", "CONNECTORS", "UNION", "UNIONS", "SENSOR", "SENSORS", "SWITCH", "SWITCHES", "VALVE", "VALVES", "SOLENOID", "SOLENOIDS", "RELAY", "RELAYS", "FUSE", "FUSES", "HARNESS", "WIRING HARNESS", "WIRES", "CABLES", "BULB", "BULBS", "LIGHT", "LIGHTS", "LED", "HEADLIGHT", "TAILLIGHT", "FOGLIGHT", "FOG LIGHT", "REPAIR KIT", "KIT", "KITS", "CAP", "CAPS", "COVER", "GLASS", "MIRROR GLASS", "DOOR SHIELD", "SHIELD", "DEF", "PARTS", "PART"
  ]);

  processed = processed
    .map(p => p.trim())
    .filter(p => {
      // Discard if it is exactly a parts name from our list of pure parts
      if (discardParts.has(p)) {
        return false;
      }
      return true;
    });

  // Unique elements
  processed = Array.from(new Set(processed));

  // If we have INSID BUMPER or BUMPER COVER, remove generic BUMPER to avoid redundancy
  if (processed.includes("INSID BUMPER") || processed.includes("BUMPER COVER")) {
    processed = processed.filter(p => p !== "BUMPER");
  }

  // Resolve multiple tire types to avoid redundant entries and merge steer and drive if both present
  let resolvedProcessed: string[] = [];
  let hasSteer = false;
  let hasDrive = false;
  let hasGenericTire = false;

  for (const p of processed) {
    if (p === "STEER & DRIVE TIRE REPLACE") {
      hasSteer = true;
      hasDrive = true;
    } else if (p === "STEER TIRE REPLACE") {
      hasSteer = true;
    } else if (p === "DRIVE TIRE REPLACE") {
      hasDrive = true;
    } else if (p === "TIRE INSTALL") {
      hasGenericTire = true;
    } else {
      resolvedProcessed.push(p);
    }
  }

  if (hasSteer && hasDrive) {
    resolvedProcessed.push("STEER & DRIVE TIRE REPLACE");
  } else if (hasSteer) {
    resolvedProcessed.push("STEER TIRE REPLACE");
  } else if (hasDrive) {
    resolvedProcessed.push("DRIVE TIRE REPLACE");
  } else if (hasGenericTire) {
    resolvedProcessed.push("TIRE INSTALL");
  }

  processed = resolvedProcessed;

  let note = processed.join(", ");
  
  if (note.length > 100) {
    note = note.substring(0, 97) + "...";
  }
  
  return note || "TRUCK SERVICE REPAIR";
}

// Rule-based fallback extractor when APIs fail
function runRuleBasedExtractor(text: string) {
  console.log("Rule-based fallback parsing. Text length:", text.length);

  // Pre-screen skip check for non-repair fuel/SO invoices
  const skipCheck = checkShouldSkipInvoice(text);
  if (skipCheck.shouldSkip) {
    return {
      isTruckInvoice: false,
      detectedBrand: "Non-Truck / Fuel",
      reasons: skipCheck.reason,
      items: []
    };
  }

  // 1. Detect Brand
  const brands = ["FREIGHTLINER", "PETERBILT", "VOLVO", "KENWORTH", "INTERNATIONAL", "WESTERN STAR", "MACK", "HINO"];
  let detectedBrand: string | null = null;
  let isTruckInvoice = false;

  for (const b of brands) {
    const regex = new RegExp("\\b" + b + "\\b", "i");
    if (regex.test(text)) {
      detectedBrand = b;
      isTruckInvoice = true;
      break;
    }
  }

  // Backup brand check for popular truck model names or words
  if (!detectedBrand) {
    if (/\bCascadia\b/i.test(text)) {
      detectedBrand = "FREIGHTLINER";
      isTruckInvoice = true;
    } else if (/\bVNL\b/i.test(text)) {
      detectedBrand = "VOLVO";
      isTruckInvoice = true;
    } else if (/\b(?:truck|tractor|semi|heavy duty|heavy-duty)\b/i.test(text)) {
      detectedBrand = "Other";
      isTruckInvoice = true;
    }
  }

  // 2. Extract Invoice Number
  let invoice = "";
  // Look for Common Invoice patterns: INV-2545, Invoice # 2545, etc.
  const invoiceRegexes = [
    /Invoice\s*(?:#|No|Num|Number)?\s*[:.-]?\s*(?:INV-)?(\d+)/i,
    /INV-(\d+)/i,
    /Invoice\s+No[.:\s#]*([a-zA-Z0-9-]+)/i,
    /Invoice[\s#:-]+([A-Za-z0-9-]+)/i,
    /#\s*(\d{4,8})\b/
  ];

  for (const regex of invoiceRegexes) {
    const match = text.match(regex);
    if (match && match[1]) {
      invoice = match[1].replace(/^(INV-)/i, "").trim();
      break;
    }
  }

  // 3. Extract Unit Number
  let unit = "";
  const unitRegexes = [
    /Unit\s*#?\s*[:.-]?\s*(\d{3,6})\b/i,
    /Truck\s*#?\s*[:.-]?\s*(\d{3,6})\b/i,
    /Tractor\s*#?\s*[:.-]?\s*(\d{3,6})\b/i,
    /Vehicle\s*#?\s*[:.-]?\s*(\d{3,6})\b/i,
    /Unit\s*#?\s*[:.-]?\s*([a-zA-Z0-9]{3,6})\b/i,
    /\b(?:Unit|Truck|Tractor)\s*[:#-]?\s*(\d+)/i
  ];

  for (const regex of unitRegexes) {
    const match = text.match(regex);
    if (match && match[1]) {
      unit = match[1].trim();
      break;
    }
  }

  // 4. Extract Service Date
  let date = "";
  const dateRegexes = [
    /(\d{2}\/\d{2}\/\d{4})/,
    /Date\s*:\s*(\d{2}\/\d{2}\/\d{4})/i,
    /Date\s*[:\s]+([0-9a-zA-Z ,:\/]+)/i,
    /(\d{2}\/\d{2}\/\d{2})/
  ];

  for (const regex of dateRegexes) {
    const match = text.match(regex);
    if (match && match[1]) {
      date = match[1].trim();
      break;
    }
  }
  // Standardize MM/DD/YY to MM/DD/YYYY
  if (date && /^\d{2}\/\d{2}\/\d{2}$/.test(date)) {
    date = date.substring(0, 6) + "20" + date.substring(6);
  } else if (!date) {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const yyyy = today.getFullYear();
    date = `${mm}/${dd}/${yyyy}`;
  }

  // 5. Extract Cost
  let cost = 0;
  // Tolerate dot leaders ("Total ........ 3,014.72") and require the capture to
  // start with a digit, so the separator dots are never parsed as the amount.
  // \b keeps the bare "Total" pattern from matching inside "Subtotal".
  const amount = "\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)";
  const costRegexes = [
    new RegExp("(?:Grand\\s+Total|Balance\\s+Due)[\\s.:]*" + amount, "i"),
    new RegExp("\\bTotal\\b[\\s.:]*" + amount, "i"),
    new RegExp("\\bSubtotal\\b[\\s.:]*" + amount, "i"),
    new RegExp("\\bAmount\\b[\\s.:]*" + amount, "i")
  ];

  for (const regex of costRegexes) {
    const match = text.match(regex);
    if (match && match[1]) {
      const val = match[1].replace(/,/g, "").trim();
      const parsedFloat = parseFloat(val);
      if (!isNaN(parsedFloat) && parsedFloat > 0) {
        cost = parsedFloat;
        break;
      }
    }
  }

  // 6. Extraction of Service description & details
  const serviceMatches: string[] = [];
  
  // Extract explicit "Service X: [Description]" titles
  const serviceRegex = /Service\s*\d+[:\s]+([^\n\r]+)/gi;
  let sMatch;
  while ((sMatch = serviceRegex.exec(text)) !== null) {
    if (sMatch[1]) {
      serviceMatches.push(sMatch[1].trim());
    }
  }

  // Also query specific detailed line items from the lines of the text (such as "bumper reinforcement", "bumper cover") to be highly accurate.
  const lines = text.split(/[\r\n]+/);
  let hasBumperCover = false;
  let hasBumperReinforcement = false;
  let hasCoolant = false;

  let hasSteerTire = false;
  let hasDriveTire = false;
  let hasTireService = false;
  let hasNoxSensor = false;
  let hasL1Bracket = false;

  for (const line of lines) {
    const upperLine = line.toUpperCase();
    if (upperLine.includes("BUMPER REINFORCEMENT") || upperLine.includes("BUMPER REINF")) {
      hasBumperReinforcement = true;
    }
    if (upperLine.includes("BUMPER COVER") || upperLine.includes("BUMPER FASCIA")) {
      hasBumperCover = true;
    }
    if (upperLine.includes("COOLANT")) {
      hasCoolant = true;
    }
    if (upperLine.includes("TIRE") || upperLine.includes("WHEEL")) {
      hasTireService = true;
      if (upperLine.includes("STEER")) {
        hasSteerTire = true;
      }
      if (upperLine.includes("DRIVE") || upperLine.includes("DRIVER")) {
        hasDriveTire = true;
      }
    }
    if (upperLine.includes("NOX") || upperLine.includes("N0X")) {
      hasNoxSensor = true;
    }
    if (
      upperLine.includes("L1") || 
      upperLine.includes("L!") || 
      (upperLine.includes("CAB") && upperLine.includes("BRACKET") && (upperLine.includes("L1") || upperLine.includes("L!")))
    ) {
      hasL1Bracket = true;
    }
  }

  // Fallback scanner for individual component keywords if no explicit services matched
  if (serviceMatches.length === 0) {
    const keyWords = [
      "COOLANT LEAK", "COOLANT", "BUMPER", "FOGLIGHT", "MIRROR", "WIPER", "BRAKE", "TIRE", 
      "OIL FILTER", "PM", "DOT", "CTC", "CEL", "RR", "LH", "RH", "ALIGNMENT", "FENDER"
    ];
    for (const kw of keyWords) {
      const regex = new RegExp("\\b" + kw + "\\b", "i");
      if (regex.test(text)) {
        serviceMatches.push(kw);
      }
    }
  }

  // Format, simplify, and deduplicate the list
  let rawNotes = serviceMatches
    .map(s => s.toUpperCase().replace(/[^A-Z0-9 &\-,]/g, "").trim())
    .filter(Boolean);

  // Apply explicit bumper and coolant mapping rules per user guidelines
  const finalKeywords: string[] = [];
  let addedBumperCover = false;
  let addedBumperReinforcement = false;
  let addedCoolant = false;

  for (const noteItem of rawNotes) {
    if (noteItem.includes("BUMPER")) {
      // Check if it specifically contains bumper cover or bumper reinforcement keywords
      if (noteItem.includes("REINFORCEMENT") || noteItem.includes("REINF")) {
        finalKeywords.push("INSID BUMPER");
        addedBumperReinforcement = true;
      } else if (noteItem.includes("COVER") || noteItem.includes("FASCIA")) {
        finalKeywords.push("BUMPER COVER");
        addedBumperCover = true;
      } else {
        // General bumper but let's check our lines detection as well
        if (hasBumperReinforcement && !addedBumperReinforcement) {
          finalKeywords.push("INSID BUMPER");
          addedBumperReinforcement = true;
        }
        if (hasBumperCover && !addedBumperCover) {
          finalKeywords.push("BUMPER COVER");
          addedBumperCover = true;
        }
        if (!addedBumperReinforcement && !addedBumperCover) {
          finalKeywords.push("BUMPER");
        }
      }
    } else if (noteItem.includes("COOLANT")) {
      if (noteItem.includes("LEAK")) {
        finalKeywords.push("COOLANT LEAK");
      } else {
        finalKeywords.push("COOLANT LINES");
      }
      addedCoolant = true;
    } else if (noteItem.includes("TIRE") || noteItem === "WHEEL" || noteItem === "WHEELS") {
      if (hasSteerTire && hasDriveTire) {
        finalKeywords.push("STEER & DRIVE TIRE REPLACE");
      } else if (hasSteerTire) {
        finalKeywords.push("STEER TIRE REPLACE");
      } else if (hasDriveTire) {
        finalKeywords.push("DRIVE TIRE REPLACE");
      } else {
        finalKeywords.push("TIRE INSTALL");
      }
    } else {
      finalKeywords.push(noteItem);
    }
  }

  // If specific parts were seen in details but not yet listed in the note, add them
  if (hasBumperReinforcement && !addedBumperReinforcement) {
    finalKeywords.push("INSID BUMPER");
  }
  if (hasBumperCover && !addedBumperCover) {
    finalKeywords.push("BUMPER COVER");
  }
  if (hasCoolant && !addedCoolant) {
    finalKeywords.push("COOLANT LINES");
  }
  if (hasNoxSensor && !finalKeywords.some(k => k.includes("NOX"))) {
    finalKeywords.push("NOX SENSOR");
  }
  if (hasL1Bracket && !finalKeywords.some(k => k.includes("L1") || k.includes("L!"))) {
    finalKeywords.push("L1 BRACKET");
  }

  let addedTireKeyword = finalKeywords.some(k => k.includes("TIRE"));
  if (hasTireService && !addedTireKeyword) {
    if (hasSteerTire && hasDriveTire) {
      finalKeywords.push("STEER & DRIVE TIRE REPLACE");
    } else if (hasSteerTire) {
      finalKeywords.push("STEER TIRE REPLACE");
    } else if (hasDriveTire) {
      finalKeywords.push("DRIVE TIRE REPLACE");
    } else {
      finalKeywords.push("TIRE INSTALL");
    }
  }

  // Clean and simplify the collected notes
  const note = cleanAndSimplifyNote(finalKeywords.join(", "));

  return {
    isTruckInvoice,
    detectedBrand,
    reasons: `Extracted brand '${detectedBrand || "Unknown"}' and details from PDF using resilient rule-based matching engine.`,
    items: [
      {
        num: 1,
        invoice: invoice || "INV-GEN",
        date: date,
        unit: unit || "UNKNOWN",
        responsible: null,
        name: null,
        cost: cost || 0.00,
        note: note,
        wo: null
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Claude extraction
// ---------------------------------------------------------------------------

type SDKEffort = NonNullable<
  Anthropic.MessageCreateParamsNonStreaming["output_config"]
>["effort"];

// Errors worth retrying on a different (smaller) model rather than giving up.
const isCapacityError = (err: any): boolean => {
  const status = err?.status ?? err?.statusCode;
  if (status === 429 || status === 529 || (typeof status === "number" && status >= 500)) {
    return true;
  }
  const text = String(err?.message || err);
  return /overloaded|rate.?limit|timeout|timed out|ECONNRESET|fetch failed/i.test(text);
};

// A depleted account will never succeed on a fallback model - fail fast.
const isCreditError = (err: any): boolean =>
  /credit balance|insufficient|billing|payment|quota/i.test(String(err?.message || err));

const buildRequest = (
  base64: string,
  model: string,
  config: AnthropicConfig,
): Anthropic.MessageCreateParamsNonStreaming => ({
  model,
  max_tokens: 16000,
  system: SYSTEM_PROMPT,
  output_config: {
    // The installed SDK's effort union predates "xhigh", which the API accepts.
    effort: config.effort as SDKEffort,
    format: { type: "json_schema" as const, schema: EXTRACTION_SCHEMA },
  },
  messages: [
    {
      role: "user" as const,
      content: [
        {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: base64,
          },
        },
        {
          type: "text" as const,
          text: "Extract all repair invoice line items from this PDF.",
        },
      ],
    },
  ],
});

// Pull the JSON payload out of a Claude response, skipping thinking blocks.
const readJSONText = (response: any): string => {
  if (response?.stop_reason === "refusal") {
    const detail = response?.stop_details?.explanation || response?.stop_details?.category || "";
    throw new Error(`Claude declined to process this document. ${detail}`.trim());
  }
  if (response?.stop_reason === "max_tokens") {
    throw new Error("Claude's response was cut off before the JSON was complete (max_tokens reached).");
  }

  const block = (response?.content || []).find((b: any) => b?.type === "text");
  if (!block?.text) {
    throw new Error("Claude returned no text content for this invoice.");
  }
  return block.text as string;
};

// One call to Claude for one PDF. Uses server-side refusal fallbacks when the
// account has the beta enabled, and transparently drops them when it doesn't.
async function callClaude(base64: string, model: string, config: AnthropicConfig): Promise<string> {
  const client = getAnthropicClient(config);
  const request = buildRequest(base64, model, config);

  try {
    const response = await client.beta.messages.create({
      ...request,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as any);
    return readJSONText(response);
  } catch (err: any) {
    const unsupportedBeta =
      (err?.status ?? err?.statusCode) === 400 &&
      /fallback|beta/i.test(String(err?.message || ""));
    if (!unsupportedBeta) throw err;

    console.warn("Server-side refusal fallbacks unavailable on this account; retrying without them.");
    const response = await client.messages.create(request);
    return readJSONText(response);
  }
}

// API Route to extract invoice metadata
app.post("/api/extract", async (req: any, res: any) => {
  try {
    const { base64 } = req.body;
    if (!base64) {
      return res.status(400).json({ error: "No PDF base64 data provided" });
    }

    const pdfBuffer = Buffer.from(base64, "base64");
    if (pdfBuffer.byteLength > MAX_PDF_BYTES) {
      return res.status(413).json({
        error: `PDF is ${(pdfBuffer.byteLength / 1024 / 1024).toFixed(1)}MB. The Anthropic API accepts up to 32MB per request - please split this invoice.`,
      });
    }

    // Pre-screen and skip logic for non-repair fuel-only invoices (like Nexus Lane LLC or SO- invoice prefix)
    let pdfTextForPreScreen = "";
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
      const textResult = await parser.getText();
      pdfTextForPreScreen = textResult.text || "";
    } catch (prescreenErr) {
      console.log("Could not extract pdf text for pre-screening:", prescreenErr);
    }

    if (pdfTextForPreScreen) {
      const skipCheck = checkShouldSkipInvoice(pdfTextForPreScreen);
      if (skipCheck.shouldSkip) {
        console.log(`Pre-screening classification: SKIPPED. Reason: ${skipCheck.reason}`);
        return res.json({
          isTruckInvoice: false,
          detectedBrand: "Non-Truck / Fuel",
          reasons: skipCheck.reason,
          items: [],
        });
      }
    }

    const config = getAnthropicConfig();
    if (!config.apiKey) {
      return res.status(500).json({
        error:
          "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key from console.anthropic.com/settings/keys.",
      });
    }

    let parsedResultText = "";
    let extractionError: any = null;

    const modelsToTry = [config.model, ...FALLBACK_MODELS.filter(m => m !== config.model)];
    console.log(`Processing extraction with Claude. Models in queue: ${modelsToTry.join(", ")}`);

    for (const currentModel of modelsToTry) {
      try {
        console.log(`Analyzing PDF natively with ${currentModel} (effort: ${config.effort})...`);
        parsedResultText = await callClaude(base64, currentModel, config);
        console.log(`Successfully completed extraction with model: ${currentModel}`);
        break;
      } catch (err: any) {
        console.warn(`Model ${currentModel} failed:`, err?.message || err);
        extractionError = err;

        if (isCreditError(err) || !isCapacityError(err)) {
          // Auth failures, bad requests, and depleted credit all fail the same
          // way on every model - stop burning time on the queue.
          break;
        }
      }
    }

    if (!parsedResultText) {
      // Local fallback extraction
      console.log("Attempting local rule-based PDF parsing fallback...");
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
        const textResult = await parser.getText();
        const extractedText = textResult.text || "";

        if (extractedText.trim().length > 0) {
          console.log(`Local standard PDF text extraction succeeded! Length: ${extractedText.length}. Running fallback matcher...`);
          const fallbackData = runRuleBasedExtractor(extractedText);
          parsedResultText = JSON.stringify(fallbackData);
        } else {
          throw new Error("Extracted PDF text is empty.");
        }
      } catch (fallbackErr: any) {
        console.error("Local fallback extraction failed:", fallbackErr?.message || fallbackErr);
        throw extractionError || fallbackErr || new Error("All tried extraction methods failed.");
      }
    }

    const cleaned = cleanJSONResponse(parsedResultText);
    const data = JSON.parse(cleaned);

    // Mandated constraint: responsible, name, and wo must always be strictly null, and simplify note formatting
    if (data && Array.isArray(data.items)) {
      data.items = data.items.map((item: any) => ({
        ...item,
        note: cleanAndSimplifyNote(item.note),
        responsible: null,
        name: null,
        wo: null,
      }));
    }

    return res.json(data);
  } catch (error: any) {
    console.error("PDF Extraction error:", error);

    const status = error?.status ?? error?.statusCode;
    let errorMessage = error?.message || "Failed to extract info from PDF";

    if (/not scoped to a workspace/i.test(errorMessage)) {
      errorMessage =
        "This Anthropic key is org-level and is not scoped to a workspace. Either create a key inside a workspace, or set ANTHROPIC_WORKSPACE_ID in your .env file.";
    } else if (status === 401) {
      errorMessage =
        "Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in your .env file.";
    } else if (status === 429 || isCreditError(error)) {
      errorMessage =
        "Anthropic API credits depleted or rate limit reached: the configured account is out of credit or has hit its limit. Review your plan and usage at console.anthropic.com.";
    }

    return res.status(500).json({ error: errorMessage });
  }
});

// Lets the UI show which model is actually wired up.
app.get("/api/config", (_req: any, res: any) => {
  const config = getAnthropicConfig();
  return res.json({
    provider: "anthropic",
    model: config.model,
    effort: config.effort,
    configured: Boolean(config.apiKey),
  });
});

// Vite Middleware and server startup wrapper to avoid top-level await in CJS output
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
