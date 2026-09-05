// Role matching. A job title is kept when it looks like an individual-contributor
// engineering / data / AI role and is not a people-manager, sales, or intern role.

export const roleFamilies = [
  "Data Engineer",
  "Analytics Engineer",
  "Data Scientist",
  "Data Analyst",
  "ML Engineer",
  "AI Engineer",
  "Software Engineer, Data/ML",
  "Business Intelligence",
  "Forward Deployed / GTM Engineer",
  "Solutions / Customer Engineer",
  "Cloud / DevOps Engineer",
  "Backend / Platform Engineer",
  "Product Engineer",
] as const;

export type RoleFamily = (typeof roleFamilies)[number];

// Order matters: the first matching family wins, so the more specific patterns come first.
// Patterns are deliberately token-based ("data … engineer") so title variants are caught without listing each one.
const role = "(?:engineer(?:ing)?|developer|specialist)";
const familyPatterns: Array<{ family: RoleFamily; pattern: RegExp }> = [
  { family: "Forward Deployed / GTM Engineer", pattern: new RegExp(`\\bforward[- ]deployed[^\\n]{0,30}\\b(?:engineer|scientist|developer)\\b|\\bdeployed (?:ai |ml |software )?engineer\\b|\\b(?:gtm|go[- ]to[- ]market|growth|revenue operations|revops|sales ops|marketing ops)[^\\n]{0,30}\\b(?:engineer|developer|specialist|automation)\\b|\\bai automation specialist\\b`, "i") },
  { family: "Solutions / Customer Engineer", pattern: new RegExp(`\\bsales engineer\\b|\\b(?:solutions?|implementation|customer|deployment|integration) engineer[^\\n]{0,25}\\b(?:data|ai|ml|cloud|analytics|platform)\\b|\\b(?:data|ai|ml|cloud|analytics) solutions? engineer\\b|\\bcustomer data engineer\\b`, "i") },
  { family: "Analytics Engineer", pattern: new RegExp(`\\banalytics[^\\n]{0,25}\\b(?:engineer(?:ing)?|developer)\\b|\\b(?:data )?visuali[sz]ation[^\\n]{0,20}\\b(?:engineer|developer)\\b|\\b(?:tableau|looker|power ?bi|qlik|sigma) (?:developer|engineer)\\b`, "i") },
  { family: "Business Intelligence", pattern: new RegExp(`\\b(?:business intelligence|\\bbi\\b)[^\\n]{0,20}\\b(?:developer|engineer(?:ing)?|analyst)\\b`, "i") },
  { family: "Data Scientist", pattern: /\b(?:data|decision|applied|ai|ml|machine learning) scientist\b|\bdata science\b|\bquantitative (?:analyst|researcher)\b|\bstatistician\b|\bai research(?:er| scientist)\b/i },
  { family: "Data Analyst", pattern: /\b(?:data|product|business|analytics|marketing|growth|insights?|bi|reporting) analyst\b|\banalytics (?:lead|specialist|consultant)\b|\bdata (?:quality|governance|operations|ops|management) analyst\b|\bdecision science analyst\b|\bdata analytics\b/i },
  { family: "ML Engineer", pattern: new RegExp(`\\b(?:machine learning|\\bml\\b|mlops|ml ?ops|deep learning|nlp|computer vision|recommendations?|ranking|llm|genai|gen ai|generative ai|rag|retrieval)[^\\n]{0,30}\\b${role}\\b|\\b${role},? (?:machine learning|ml|mlops|llm|genai|deep learning|nlp)\\b|\\bresearch engineer\\b`, "i") },
    { family: "AI Engineer", pattern: new RegExp(`\\b(?:ai|artificial intelligence|agentic|ai agents?|llm|prompt|evaluations?)[^\\n]{0,30}\\b(?:engineer(?:ing)?|developer)\\b|\\b${role},? (?:applied |generative |agentic )?ai\\b|\\bai (?:automation )?specialist\\b|\\bmember of technical staff\\b`, "i") },
  { family: "Data Engineer", pattern: new RegExp(`\\bdata architect\\b|\\bdatabase (?:engineer|developer|reliability engineer)\\b|\\b(?:data|etl|elt|etl/elt|dataops|big data|spark|pyspark|kafka|flink|airflow|dbt|snowflake|databricks|nifi|hadoop|dataiku|palantir foundry|foundry|lakehouse|streaming|data pipelines?|pipelines?|data warehouse)\\b[^\\n]{0,30}\\b${role}\\b|\\b${role},? (?:big )?data\\b|\\bdata engineering\\b`, "i") },
  { family: "Software Engineer, Data/ML", pattern: /\b(?:software|backend|back-end|fullstack|full-stack|full stack|platform|infrastructure|staff|senior|principal|founding) engineer(?:ing)?[^\n]{0,50}\b(?:data|analytics|ml|machine learning|ai|llm|search|ranking|pipelines?|warehouse|lakehouse|streaming|kafka|spark|bi)\b/i },
  { family: "Cloud / DevOps Engineer", pattern: /\b(?:cloud|aws|gcp|google cloud|azure|devops|dev ops|multi-cloud) (?:platform |infrastructure |solutions |systems |software |ops )?engineer(?:ing)?\b/i },
  // Server-side roles close to data engineering. Plain "Software Engineer", frontend, mobile and generic
  // "Systems Engineer" (usually IT/hardware) are deliberately not matched.
  { family: "Backend / Platform Engineer", pattern: /\b(?:backend|back-end|back end|platform|infrastructure|infra|distributed systems|server-side|api) (?:software )?(?:engineer(?:ing)?|developer)\b|\bsoftware (?:engineer(?:ing)?|developer)[^\n]{0,30}\b(?:backend|back-end|back end|platform|infrastructure|infra|distributed systems|server-side)\b/i },
  { family: "Product Engineer", pattern: /\bproduct engineer(?:ing)?\b/i },
];

// Titles that are technically matched but not the kind of job worth applying to here.
const excludedTitle = /\b(?:director|manager|head of|vp|vice president|chief|cto|cio|intern(?:ship)?|co-?op|apprentice|student|fellow|professor|recruiter|sales representative|sales development|account executive|account manager|evangelist|instructor|teacher|trainer|clerk|technician|electrician|mechanical|electrical|civil|structural|hvac|data center|data centre|datacenter|data entry|warehouse (?:associate|worker|operations|specialist|lead|supervisor|clerk|coordinator)|forklift|nurse|nursing|rn|lpn|clinical|oncology|registrar|coder|coding specialist|abstractor|drug|(?<!data )quality engineer|virtual desktop|vdi|field service|maintenance|janitor|driver|cashier|receptionist|paralegal)\b/i;

export function classifyRole(title: string): RoleFamily | null {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean || excludedTitle.test(clean)) return null;
  return familyPatterns.find(item => item.pattern.test(clean))?.family ?? null;
}

export function isTargetTitle(title: string) {
  return classifyRole(title) !== null;
}

export function seniority(title: string): "Junior" | "Mid" | "Senior" | "Staff+" {
  if (/\b(?:staff|principal|distinguished|lead|architect)\b/i.test(title)) return "Staff+";
  if (/\b(?:senior|sr\.?|iii|iv)\b/i.test(title)) return "Senior";
  if (/\b(?:junior|jr\.?|associate|entry|new grad|graduate|i\b|early career)\b/i.test(title)) return "Junior";
  return "Mid";
}
