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
  "Cloud / DevOps Engineer",
  "Product Engineer",
] as const;

export type RoleFamily = (typeof roleFamilies)[number];

// Order matters: the first matching family wins, so the more specific patterns come first.
const familyPatterns: Array<{ family: RoleFamily; pattern: RegExp }> = [
  { family: "Forward Deployed / GTM Engineer", pattern: /\bforward[- ]deployed[^\n]{0,30}\b(?:engineer|scientist|developer)\b|\bdeployed (?:ai |ml |software )?engineer\b|\b(?:gtm|go[- ]to[- ]market) engineer\b|\bsolutions? engineer,? (?:ai|ml|data)\b/i },
  { family: "Analytics Engineer", pattern: /\banalytics engineer(?:ing)?\b/i },
  { family: "Business Intelligence", pattern: /\b(?:business intelligence|\bbi\b)(?: developer| engineer| analyst)?\b/i },
  { family: "Data Engineer", pattern: /\b(?:data|etl|elt|data ?warehouse|data platform|data infrastructure|data pipeline|data integration|data reliability|data ops|dataops|big data|spark|snowflake|databricks|dbt) (?:platform |infrastructure |integration |reliability |pipeline |warehouse |ops |ops |software |solutions )?engineer(?:ing)?\b|\bengineer,? (?:big )?data(?: (?:platform|infrastructure|engineering|pipelines?|warehouse))?\b|\bdata engineering\b|\b(?:etl|elt|data ?warehouse|dbt|snowflake|databricks|data) developer\b/i },
  { family: "Data Scientist", pattern: /\b(?:data|decision|applied) scientist\b|\bdata science\b|\bquantitative (?:analyst|researcher)\b|\bstatistician\b/i },
  { family: "Data Analyst", pattern: /\b(?:data|product|business|analytics|marketing|growth|insights?) analyst\b|\banalytics (?:lead|specialist|consultant)\b|\bdata analytics\b/i },
  { family: "ML Engineer", pattern: /\b(?:machine learning|\bml\b|mlops|ml ?ops|deep learning|nlp|computer vision|recommendation|ranking|llm|genai|gen ai|generative ai)(?: (?:platform|infrastructure|infra|research|software|systems|ops|applied|inference|training))* engineer(?:ing)?\b|\bengineer,? (?:machine learning|ml|mlops|llm|genai|deep learning|nlp)\b|\bresearch engineer\b/i },
  { family: "AI Engineer", pattern: /\b(?:applied |generative |conversational |agentic )?(?:ai|artificial intelligence|agent|agents|llm|prompt)(?: (?:platform|infrastructure|product|software|systems|applied|solutions))* engineer(?:ing)?\b|\bengineer,? (?:applied )?ai\b|\bai (?:developer|specialist|technologist)\b|\bmember of technical staff\b/i },
  { family: "Software Engineer, Data/ML", pattern: /\b(?:software|backend|back-end|fullstack|full-stack|full stack|platform|infrastructure|staff|senior|principal|founding) engineer(?:ing)?[^\n]{0,50}\b(?:data|analytics|ml|machine learning|ai|llm|search|ranking|pipelines?|warehouse|lakehouse|streaming|kafka|spark|ai product|ai platform|ml platform|data platform|ai infrastructure)\b/i },
  { family: "Cloud / DevOps Engineer", pattern: /\b(?:cloud|aws|gcp|google cloud|azure|devops|dev ops|multi-cloud) (?:platform |infrastructure |solutions |systems |software |ops )?engineer(?:ing)?\b/i },
  { family: "Product Engineer", pattern: /\bproduct engineer(?:ing)?\b/i },
];

// Titles that are technically matched but not the kind of job worth applying to here.
const excludedTitle = /\b(?:director|manager|head of|vp|vice president|chief|cto|cio|intern(?:ship)?|co-?op|apprentice|student|fellow|professor|recruiter|sales|account executive|account manager|evangelist|instructor|teacher|trainer|clerk|technician|electrician|mechanical|electrical|civil|structural|hvac|data center|data centre|datacenter)\b/i;

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
