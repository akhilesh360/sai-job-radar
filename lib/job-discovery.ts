export const roleOptions = [
  "Data Engineer",
  "AI Engineer",
  "Analytics Engineer",
  "Software Engineer, Data",
  "Data Scientist",
  "Business Intelligence Engineer",
  "GTM Engineer",
  "Forward Deployed Engineer",
  "ML Engineer",
  "Senior Analytics Engineer",
  "Product Engineer",
  "Cloud Engineer",
  "AWS Engineer",
  "GCP Engineer",
] as const;

export type RoleOption=typeof roleOptions[number];
export const googleRoleFamilies = [
  {key:"Data Engineering",phrases:["Data Engineer","Senior Data Engineer","Data Engineer II","Software Engineer, Data","Software Engineer - Data","Data Platform Engineer","Data Infrastructure Engineer","Data Integration Engineer","ETL Engineer","Cloud Data Engineer","Data Reliability Engineer","Forward Deployed Data Engineer","Data Engineering"]},
  {key:"Analytics & BI",phrases:["Analytics Engineer","Senior Analytics Engineer","Business Intelligence Engineer","BI Engineer","Data Analytics Engineer","Product Analytics Engineer"]},
  {key:"Data Science",phrases:["Data Scientist","Senior Data Scientist","Applied Data Scientist","Product Data Scientist","Decision Scientist"]},
  {key:"AI & ML",phrases:["AI Engineer","Artificial Intelligence Engineer","Machine Learning Engineer","ML Engineer","Applied AI Engineer","Generative AI Engineer","LLM Engineer","AI Platform Engineer","Machine Learning Platform Engineer"]},
  {key:"GTM & FDE",phrases:["GTM Engineer","Go To Market Engineer","Forward Deployed Engineer","Forward Deployed Software Engineer","Forward Deployed Data Engineer"]},
  {key:"Product Engineering",phrases:["Product Engineer","AI Product Engineer","Data Product Engineer"]},
  {key:"Cloud Engineering",phrases:["Cloud Engineer","AWS Engineer","GCP Engineer","Cloud Platform Engineer"]},
] as const;

const titlePatterns:Array<{role:RoleOption;pattern:RegExp}> = [
  {role:"Senior Analytics Engineer",pattern:/\b(?:senior|sr\.?|staff|lead|principal) analytics engineer\b/i},
  {role:"Software Engineer, Data",pattern:/\b(?:software|backend) engineer(?:ing)?[, /-]+(?:data|analytics|data platform|data infrastructure)\b/i},
  {role:"Data Engineer",pattern:/\b(?:big )?data (?:platform |infrastructure |integration |reliability |warehouse |etl )?engineer\b|\betl engineer\b|\b(?:member of technical staff|mts|software engineer|staff engineer|principal engineer)[^\n]{0,60}\bdata engineering\b/i},
  {role:"AI Engineer",pattern:/\b(?:(?:applied|generative) )?(?:ai|artificial intelligence)(?: software| platform)? engineer\b|\bllm engineer\b/i},
  {role:"Analytics Engineer",pattern:/\b(?:product |data )?analytics engineer\b/i},
  {role:"Data Scientist",pattern:/\b(?:(?:senior|sr\.?|staff|lead|principal|applied|product) )?(?:data|decision) scientist\b/i},
  {role:"Business Intelligence Engineer",pattern:/\b(?:business intelligence|bi) engineer\b/i},
  {role:"GTM Engineer",pattern:/\b(?:gtm|go[- ]to[- ]market) engineer\b/i},
  {role:"Forward Deployed Engineer",pattern:/\bforward[- ]deployed (?:software )?engineer\b/i},
  {role:"ML Engineer",pattern:/\b(?:machine learning|ml)(?: software| platform)? engineer\b/i},
  {role:"Product Engineer",pattern:/\b(?:ai |data )?product engineer\b/i},
  {role:"AWS Engineer",pattern:/\baws (?:cloud )?engineer\b/i},
  {role:"GCP Engineer",pattern:/\b(?:gcp|google cloud) engineer\b/i},
  {role:"Cloud Engineer",pattern:/\bcloud (?:platform |infrastructure )?engineer\b/i},
];

export function classifyRole(title:string):RoleOption|null{return titlePatterns.find(item=>item.pattern.test(title))?.role??null}
export function matchesTargetRole(title:string){return classifyRole(title)!==null}
export function isAllowedTargetTitle(title:string){return matchesTargetRole(title)&&!/\b(?:director|manager|architect|vice president|vp)\b/i.test(title)}

export const discoveryDomains = [
  "jobs.ashbyhq.com",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "ats.rippling.com",
  "apply.workable.com",
  "jobs.smartrecruiters.com",
  "myworkdayjobs.com",
  "jobs.jobvite.com",
  "applytojob.com",
  "recruitee.com",
  "breezy.hr",
  "comeet.com/jobs",
  "pinpointhq.com",
  "icims.com/jobs",
  "careers-page.com",
] as const;

export const googleDiscoveryDomains = [
  "jobs.ashbyhq.com","job-boards.greenhouse.io","boards.greenhouse.io","jobs.lever.co",
  "apply.workable.com","jobs.smartrecruiters.com","jobs.jobvite.com","applytojob.com",
  "recruitee.com","breezy.hr","comeet.com/jobs","pinpointhq.com",
] as const;

const atsHosts:Array<{ats:string;hosts:string[]}>= [
  {ats:"Ashby",hosts:["jobs.ashbyhq.com"]},
  {ats:"Greenhouse",hosts:["job-boards.greenhouse.io","boards.greenhouse.io"]},
  {ats:"Lever",hosts:["jobs.lever.co"]},
  {ats:"Rippling",hosts:["ats.rippling.com"]},
  {ats:"Workable",hosts:["apply.workable.com","jobs.workable.com"]},
  {ats:"SmartRecruiters",hosts:["jobs.smartrecruiters.com"]},
  {ats:"Workday",hosts:["myworkdayjobs.com"]},
  {ats:"Jobvite",hosts:["jobs.jobvite.com"]},
  {ats:"JazzHR",hosts:["applytojob.com"]},
  {ats:"Recruitee",hosts:["recruitee.com"]},
  {ats:"Breezy",hosts:["breezy.hr"]},
  {ats:"Comeet",hosts:["comeet.com"]},
  {ats:"Pinpoint",hosts:["pinpointhq.com"]},
  {ats:"iCIMS",hosts:["icims.com"]},
  {ats:"CareerPage",hosts:["careers-page.com"]},
  {ats:"Teamtailor",hosts:["jobs.teamtailor.com"]},
  {ats:"Gem",hosts:["jobs.gem.com"]},
  {ats:"ADP",hosts:["workforcenow.adp.com"]},
  {ats:"Oracle",hosts:["fa.ocs.oraclecloud.com"]},
];

export type ParsedSource={id:string;ats:string;slug:string;companyName:string;boardUrl:string;origin:string};
export function parseSourceUrl(rawUrl:string,origin="search"):ParsedSource|null{
  try{
    const url=new URL(rawUrl);const host=url.hostname.toLowerCase();const parts=url.pathname.split("/").filter(Boolean);const match=atsHosts.find(item=>item.hosts.some(value=>host===value||host.endsWith(`.${value}`)));
    if(!match)return null;let slug=parts[0]??host.split(".")[0];
    if(match.ats==="Workday")slug=host.split(".")[0];
    if(match.ats==="Breezy"||match.ats==="Recruitee"||match.ats==="Pinpoint"||match.ats==="JazzHR")slug=host.split(".")[0];
    if(match.ats==="Comeet"){
      const jobsIndex=parts.findIndex(part=>part.toLowerCase()==="jobs"),tenant=parts[jobsIndex+1],boardCode=parts[jobsIndex+2];
      if(!tenant||!boardCode)return null;slug=`${tenant}|${boardCode}`;
    }
    if(!slug||["embed","jobs","job","careers","apply"].includes(slug.toLowerCase()))return null;
    slug=decodeURIComponent(slug).trim();const canonicalSlug=slug.toLowerCase().replace(/\s+/g,"-");
    const companySlug=match.ats==="Comeet"?slug.split("|")[0]:slug,boardUrl=match.ats==="Comeet"?`https://www.comeet.com/jobs/${slug.replace("|","/")}`:`https://${host}/${encodeURIComponent(slug)}`;
    return {id:`${match.ats}:${canonicalSlug}`.toLowerCase(),ats:match.ats,slug,companyName:companySlug.replace(/[-_]+/g," ").replace(/\b\w/g,char=>char.toUpperCase()),boardUrl,origin};
  }catch{return null}
}

export const discoveryQuery = roleOptions.map(role=>`"${role}"`).join(" OR ");
