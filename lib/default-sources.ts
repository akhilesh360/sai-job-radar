export const defaultSources=[
  ["Ashby","openai","OpenAI"],["Ashby","vanta","Vanta"],["Ashby","whatnot","Whatnot"],["Ashby","baseten","Baseten"],["Ashby","abridge","Abridge"],["Ashby","regard","Regard"],
  ["Greenhouse","anthropic","Anthropic"],["Greenhouse","roku","Roku"],["Greenhouse","hasbro","Hasbro"],["Greenhouse","simplepractice55","SimplePractice"],
  ["Lever","gopuff","Gopuff"],["Lever","redwoodcu","Redwood Credit Union"],["Lever","foodsmart","Foodsmart"],["Lever","floqast","FloQast"],
  ["AI Jobs","us","AI Jobs (artificialintelligencejobs.co)"],
  ["Workable Search","us","Workable job search (jobs.workable.com)"],
].map(([ats,slug,companyName])=>({id:`${ats}:${slug}`.toLowerCase(),ats,slug,companyName,boardUrl:ats==="AI Jobs"?`https://artificialintelligencejobs.co/`:ats==="Workable Search"?`https://jobs.workable.com/`:ats==="Ashby"?`https://jobs.ashbyhq.com/${slug}`:ats==="Greenhouse"?`https://job-boards.greenhouse.io/${slug}`:`https://jobs.lever.co/${slug}`,origin:"poc",status:"active",active:true}));
