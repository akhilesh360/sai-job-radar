/**
 * Job-description intelligence, deterministic and cheap: plain text from HTML, the tools/skills a posting names,
 * the years of experience it asks for, and hard blockers (no sponsorship, citizenship, clearance). Feeds the fit
 * score and the tags on each job row.
 */

type SkillEntry = { name: string; aliases?: string[]; cs?: boolean; /** match aliases only — the bare name is an ordinary word or a single letter */ noBare?: boolean };
// `cs` = case-sensitive: words that are also ordinary English ("Spark", "Excel", "Hive") only count when capitalised
// like the product. Company names (OpenAI, Anthropic, Claude) are deliberately not skills.
const skillDictionary: SkillEntry[] = [
  { name: "Python" }, { name: "SQL" }, { name: "Scala" }, { name: "Java" }, { name: "Go", aliases: ["golang", "Go (programming|language|developer)", "Go/", "/Go"], cs: true, noBare: true }, { name: "Rust", cs: true }, { name: "TypeScript" }, { name: "JavaScript" }, { name: "R", aliases: ["R programming", "RStudio", "tidyverse", "R/Python", "Python/R", "R and Python", "Python and R", "SQL, R", "R, SQL", "R, Python", "Python, R"], cs: true, noBare: true }, { name: "Bash" },
  { name: "PySpark" }, { name: "Spark", aliases: ["Apache Spark", "Spark SQL"], cs: true }, { name: "Databricks" }, { name: "Delta Lake" }, { name: "Unity Catalog" }, { name: "Snowflake" }, { name: "BigQuery" }, { name: "Redshift" }, { name: "Synapse", aliases: ["Azure Synapse"], cs: true }, { name: "Athena", aliases: ["Amazon Athena", "AWS Athena"], cs: true },
  { name: "dbt" }, { name: "Airflow", aliases: ["Apache Airflow"] }, { name: "Dagster" }, { name: "Prefect", cs: true }, { name: "Fivetran" }, { name: "Kafka", aliases: ["Apache Kafka"] }, { name: "Flink" }, { name: "Kinesis" }, { name: "Pub/Sub", aliases: ["pubsub"] }, { name: "Structured Streaming", aliases: ["Spark Streaming"] },
  { name: "Hadoop" }, { name: "Hive", aliases: ["Apache Hive"], cs: true }, { name: "Presto", cs: true }, { name: "Trino" }, { name: "Iceberg", aliases: ["Apache Iceberg"], cs: true }, { name: "Hudi" }, { name: "Parquet" }, { name: "Kubernetes", aliases: ["k8s"] }, { name: "Docker" }, { name: "Terraform" }, { name: "CI/CD", aliases: ["ci cd", "cicd"] }, { name: "Git", cs: true },
  { name: "AWS", aliases: ["Amazon Web Services"] }, { name: "Azure" }, { name: "GCP", aliases: ["Google Cloud"] }, { name: "S3" }, { name: "Lambda", aliases: ["AWS Lambda"], cs: true }, { name: "Glue", aliases: ["AWS Glue"], cs: true }, { name: "EMR" }, { name: "Step Functions" }, { name: "Data Factory", aliases: ["Azure Data Factory"] }, { name: "Dataflow", cs: true }, { name: "Dataproc" },
  { name: "Postgres", aliases: ["PostgreSQL"] }, { name: "MySQL" }, { name: "MongoDB" }, { name: "DynamoDB" }, { name: "Cassandra" }, { name: "Elasticsearch" }, { name: "Redis" }, { name: "Oracle DB", aliases: ["Oracle Database", "PL/SQL"] }, { name: "SQL Server", aliases: ["T-SQL", "MSSQL"] },
  { name: "Tableau" }, { name: "Power BI", aliases: ["PowerBI"] }, { name: "Looker" }, { name: "Metabase" }, { name: "Sigma Computing" }, { name: "Superset" }, { name: "Excel", aliases: ["Microsoft Excel", "MS Excel"], cs: true },
  { name: "Pandas", cs: true }, { name: "NumPy" }, { name: "scikit-learn", aliases: ["sklearn"] }, { name: "PyTorch" }, { name: "TensorFlow" }, { name: "XGBoost" }, { name: "MLflow" }, { name: "Feature Store" }, { name: "SageMaker" }, { name: "Vertex AI" }, { name: "Hugging Face", aliases: ["huggingface"] },
  { name: "LLM", aliases: ["LLMs", "large language model"] }, { name: "RAG", aliases: ["retrieval-augmented", "retrieval augmented"], cs: true }, { name: "LangChain" }, { name: "LangGraph" }, { name: "OpenAI API", aliases: ["GPT-4", "GPT-4o", "ChatGPT API"] }, { name: "Vector DB", aliases: ["vector database", "Pinecone", "Weaviate", "pgvector", "Milvus"] }, { name: "Prompt Engineering" }, { name: "AI Agents", aliases: ["agentic", "AI agents", "multi-agent"] },
  { name: "Data Modeling", aliases: ["data modelling", "dimensional model", "star schema"] }, { name: "ETL" }, { name: "ELT", cs: true }, { name: "Data Warehouse", aliases: ["data warehousing"] }, { name: "Lakehouse", aliases: ["data lake"] }, { name: "Medallion" }, { name: "Data Governance" }, { name: "Data Quality" }, { name: "Great Expectations" }, { name: "Data Lineage" },
  { name: "REST APIs", aliases: ["REST API", "RESTful"] }, { name: "GraphQL" }, { name: "gRPC" }, { name: "Microservices" }, { name: "Linux" }, { name: "Agile", aliases: ["Scrum"] }, { name: "Jira" },
  { name: "Salesforce" }, { name: "SAP", cs: true }, { name: "NetSuite" }, { name: "Twilio Segment" }, { name: "Amplitude", cs: true }, { name: "Mixpanel" }, { name: "Google Analytics" }, { name: "A/B Testing", aliases: ["experimentation"] }, { name: "Statistics", aliases: ["statistical modeling", "statistical analysis"] },
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const skillPatterns = skillDictionary.map(entry => ({
  canonical: entry.name,
  pattern: new RegExp(`(?<![A-Za-z0-9])(?:${[...(entry.noBare ? [] : [entry.name]), ...(entry.aliases ?? [])].map(alias => /[()|]/.test(alias) ? alias : escapeRegExp(alias)).join("|")})(?![A-Za-z0-9])`, entry.cs ? "" : "i"),
}));

export function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&rsquo;|&lsquo;/g, "\u2019").replace(/&nbsp;/g, " ")
    .replace(/<(br|\/p|\/li|\/div|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function extractSkills(text: string): string[] {
  const found: string[] = [];
  for (const { canonical, pattern } of skillPatterns) if (pattern.test(text)) found.push(canonical);
  return found;
}

/** Smallest "N+ years" requirement in the text — the bar to clear — or null. */
export function extractYears(text: string): number | null {
  const years: number[] = [];
  for (const match of text.matchAll(/(\d{1,2})\s*(?:\+|plus|or more)?\s*(?:-|to|–)?\s*(?:\d{1,2})?\s*\+?\s*(?:years|yrs)(?:'|\u2019)?\s+(?:of\s+)?(?:\w+\s+){0,4}?(?:experience|exp\b)/gi)) {
    const n = Number(match[1]); if (n >= 1 && n <= 20) years.push(n);
  }
  return years.length ? Math.min(...years) : null;
}

export type JdFlag = "no-sponsorship" | "citizens-only" | "clearance" | "sponsorship-offered";

export function extractFlags(text: string): JdFlag[] {
  const flags = new Set<JdFlag>();
  if (/\b(?:unable|not able|cannot|can't|won't|will not|do(?:es)? not|no)\s+(?:\w+\s+){0,3}sponsor(?:ship)?\b|without (?:the need for |requiring )?(?:visa )?sponsorship|sponsorship (?:is )?not (?:available|offered|provided)|no visa sponsorship|must (?:be|have) (?:legally )?authori[sz]ed to work[^.]{0,60}(?:without|no) (?:visa )?sponsorship/i.test(text)) flags.add("no-sponsorship");
  if (/\b(?:U\.?S\.?|United States) citizens?(?:hip)? (?:is |are )?(?:required|only)|\bmust be a (?:U\.?S\.?|United States) citizen|\bcitizenship (?:is )?required|\bU\.?S\.? person\b|\bITAR\b|export control/i.test(text)) flags.add("citizens-only");
  if (/\b(?:security clearance|TS\/SCI|top secret|secret clearance|public trust|clearance (?:is )?required|active clearance)\b/i.test(text)) flags.add("clearance");
  if (/\b(?:visa sponsorship (?:is )?(?:available|offered|provided)|will sponsor|sponsorship available|we sponsor|open to sponsoring|h-?1b (?:transfer|sponsorship) (?:available|welcome|ok)|offers? (?:visa )?sponsorship)\b/i.test(text)) flags.add("sponsorship-offered");
  if (flags.has("sponsorship-offered")) flags.delete("no-sponsorship");
  return [...flags];
}

export type JdSummary = { skills: string[]; years: number | null; flags: JdFlag[] };
export function summarizeJd(rawHtmlOrText: string): JdSummary {
  const text = /<[a-z][\s\S]*>|&lt;/i.test(rawHtmlOrText) ? htmlToText(rawHtmlOrText) : rawHtmlOrText;
  return { skills: extractSkills(text), years: extractYears(text), flags: extractFlags(text) };
}
export const hasHardBlocker = (flags: readonly string[]) => flags.includes("no-sponsorship") || flags.includes("citizens-only") || flags.includes("clearance");
