import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { sourceBoards, systemState } from "../db/schema";
import seedSources1 from "../data/source-seeds-1.json";
import seedSources2 from "../data/source-seeds-2.json";
import seedSources3 from "../data/source-seeds-3.json";
import seedSources4 from "../data/source-seeds-4.json";
import seedSources5 from "../data/source-seeds-5.json";
import seedSources6 from "../data/source-seeds-6.json"; // S&P 500 boards on connectable ATSs (atsresumeai.com study, 2026-06)
import seedSources7 from "../data/source-seeds-7.json"; // boards from the owner's 2025–26 application trackers that the catalog lacked
import seedSources8 from "../data/source-seeds-8.json"; // boards behind SimplifyJobs/New-Grad-Positions listings.json (active tech/data postings)
import seedSources9 from "../data/source-seeds-9.json"; // Y Combinator companies hiring in the US, boards resolved by scripts/resolve-yc-boards.mjs
import seedSources10 from "../data/source-seeds-10.json"; // boards behind artificialintelligencejobs.co US listings
import seedSources11 from "../data/source-seeds-11.json"; // SmartRecruiters boards with US postings from the owner's old scraper lists (2026-09)
import seedSources12 from "../data/source-seeds-12.json"; // boards behind the owner's saved application links (2026-09)
import seedSources13 from "../data/source-seeds-13.json"; // Gem boards from the owner's saved application links (2026-09)
import seedSources14 from "../data/source-seeds-14.json"; // openjobdata.com companies (US, readable ATS) that have posted a data/ML role (2026-09)
import seedSources15 from "../data/source-seeds-15.json";
import seedSources17 from "../data/source-seeds-17.json"; // readable boards found via JobDataLake's index that the catalog lacked (2026-09)
import seedSources16 from "../data/source-seeds-16.json"; // BCG on Phenom (2026-09). Workday tenants were seeded here for a day and removed: the owner does not want Workday at all // the remaining openjobdata.com US companies on readable ATSs (no data-role history yet) — owner wants full coverage

const seedSources = [
  ...seedSources1,
  ...seedSources2,
  ...seedSources3,
  ...seedSources4,
  ...seedSources5,
  ...seedSources6,
  ...seedSources7,
  ...seedSources8,
  ...seedSources9,
  ...seedSources10,
  ...seedSources11,
  ...seedSources12,
  ...seedSources13,
  ...seedSources14,
  ...seedSources15,
  ...seedSources16,
  ...seedSources17,
];

const progressKey = "seed_catalog_offset";

export async function getCatalogOffset(){
  const rows=await getDb().select({value:systemState.value}).from(systemState).where(eq(systemState.key,progressKey)).limit(1);
  return Math.min(seedSources.length,Math.max(0,Number.parseInt(rows[0]?.value??"0",10)||0));
}

async function saveCatalogOffset(offset:number){
  const db=getDb(),now=new Date().toISOString(),current=await getCatalogOffset(),value=String(Math.max(current,offset));
  await db.insert(systemState).values({key:progressKey,value,updatedAt:now}).onConflictDoUpdate({target:systemState.key,set:{value,updatedAt:now}});
}

export async function importSourceSeedBatch(offset:number,limit:number){
  const safeOffset=Math.min(seedSources.length,Math.max(0,offset));
  const safeLimit=Math.min(250,Math.max(1,limit));
  const batch=seedSources.slice(safeOffset,safeOffset+safeLimit);
  if(batch.length){
    const db=getDb();
    // D1 allows 100 bound parameters per statement; a source_boards row binds 11 (8 values + 3 numeric defaults), so 8 rows max.
    for(let index=0;index<batch.length;index+=8){
      await db.insert(sourceBoards).values(batch.slice(index,index+8).map(source=>({...source,status:"pending",active:false}))).onConflictDoNothing();
    }
  }
  const nextOffset=safeOffset+batch.length;
  await saveCatalogOffset(nextOffset);
  return {imported:batch.length,nextOffset,total:seedSources.length,complete:nextOffset>=seedSources.length};
}

export const sourceSeedCount=seedSources.length;
