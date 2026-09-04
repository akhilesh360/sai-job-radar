// US location detection. ATS boards write locations in dozens of formats
// ("Remote U.S.", "SF Office", "New York", "Remote (US)", "Austin, TX", "Bengaluru, India"),
// so we check for explicit foreign signals first, then a broad set of US signals.

const foreign = /\b(Canada|Canadian|Toronto|Vancouver|Montr[eé]al|Ottawa|Calgary|Ontario|Quebec|British Columbia|Alberta|United Kingdom|\bUK\b|England|London|Scotland|Edinburgh|Ireland|Dublin|Europe|European|EMEA|APAC|LATAM|Germany|Berlin|Munich|Hamburg|France|Paris|Spain|Madrid|Barcelona|Italy|Milan|Rome|Netherlands|Amsterdam|Belgium|Brussels|Switzerland|Zurich|Zürich|Austria|Vienna|Sweden|Stockholm|Norway|Oslo|Denmark|Copenhagen|Finland|Helsinki|Poland|Warsaw|Krak[oó]w|Portugal|Lisbon|Czech|Prague|Hungary|Budapest|Romania|Bucharest|Ukraine|Kyiv|Estonia|Tallinn|Latvia|Lithuania|Greece|Athens|Turkey|Istanbul|Israel|Tel Aviv|UAE|Dubai|Abu Dhabi|Saudi|Riyadh|Qatar|Egypt|Cairo|Nigeria|Lagos|Kenya|Nairobi|South Africa|Johannesburg|Cape Town|India|Bengaluru|Bangalore|Hyderabad|Chennai|Mumbai|Pune|Noida|Gurgaon|Gurugram|New Delhi|Delhi|Kolkata|Uttar Pradesh|Maharashtra|Karnataka|Telangana|Tamil Nadu|Haryana|Gujarat|Kerala|Pakistan|Karachi|Lahore|Bangladesh|Dhaka|Sri Lanka|Colombo|Singapore|Malaysia|Kuala Lumpur|Indonesia|Jakarta|Philippines|Manila|Vietnam|Hanoi|Ho Chi Minh|Thailand|Bangkok|Japan|Tokyo|Osaka|Korea|Seoul|China|Beijing|Shanghai|Shenzhen|Hong Kong|Taiwan|Taipei|Australia|Sydney|Melbourne|Brisbane|Perth|New Zealand|Auckland|Wellington|Mexico|Mexico City|Guadalajara|Monterrey|Brazil|S[aã]o Paulo|Rio de Janeiro|Argentina|Buenos Aires|Chile|Santiago|Colombia|Bogot[aá]|Medell[ií]n|Peru|Lima|Costa Rica|Uruguay|Montevideo)\b/i;

const usExplicit = /\b(United States|US-based|US based|USA|Remote[ -]+US|US[ -]+Remote|Remote \(US\)|Anywhere in the US|Nationwide|District of Columbia|Washington,? D\.?C\.?)\b/i;
// "US", "U.S.", "U.S.A." as a standalone token (case-sensitive so "us" in prose never matches).
const usToken = /(?:^|[\s,(/|-])U\.?S\.?A?\.?(?=[\s,)\]/|.-]|$)/;

const usStates = /\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Puerto Rico)\b/i;

// Two-letter state codes are case-sensitive and must not be part of a longer word.
const usStateCodes = /(?:^|[\s,(/|-])(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?=$|[\s,)/|.-])/;

const usCities = /\b(New York(?: City)?|NYC|Manhattan|Brooklyn|San Francisco|SF(?: Bay Area| Office)?|Bay Area|South Bay|Silicon Valley|Palo Alto|Mountain View|Menlo Park|Sunnyvale|San Jose|San Mateo|Redwood City|Oakland|Berkeley|Los Angeles|LA Office|Santa Monica|San Diego|Irvine|Sacramento|Seattle|Bellevue|Redmond|Kirkland|Portland|Denver|Boulder|Austin|Dallas|Houston|San Antonio|Plano|Chicago|Boston|Cambridge, MA|Somerville|Atlanta|Miami|Tampa|Orlando|Phoenix|Scottsdale|Tempe|Salt Lake City|Las Vegas|Minneapolis|St\.? Paul|Detroit|Ann Arbor|Pittsburgh|Philadelphia|Baltimore|Washington|Arlington|Reston|McLean|Raleigh|Durham|Charlotte|Nashville|Columbus|Cleveland|Cincinnati|Indianapolis|Kansas City|St\.? Louis|Milwaukee|Madison|Omaha|Richmond|Charlottesville|Boise|Albuquerque|Tucson|Honolulu|Anchorage|New Orleans|Louisville|Memphis|Birmingham|Oklahoma City|Tulsa|Des Moines|Hartford|Stamford|Providence|Jersey City|Hoboken|Newark|Princeton|Santa Clara|Fremont|Cupertino|Burlingame|Emeryville|Pasadena|Long Beach|Anaheim|Costa Mesa|Newport Beach|Santa Barbara|Fort Worth|Frisco|Round Rock|Chandler|Mesa|Aurora|Fort Collins|Colorado Springs|Bethesda|Rockville|Alexandria|Herndon|Tysons|Chapel Hill|Cary|Jacksonville|Fort Lauderdale|Boca Raton|West Palm Beach|Sarasota|St\.? Petersburg|Greenville|Charleston|Savannah|Lexington|Grand Rapids|Rochester|Buffalo|Albany|Syracuse|Ithaca|Burlington|Portsmouth|Manchester, NH|Wilmington|Dover|Bentonville|Little Rock|Baton Rouge|Huntsville|Knoxville|Chattanooga|Reno|Spokane|Tacoma|Eugene|Bozeman|Missoula|Fargo|Sioux Falls|Cheyenne|Lincoln|Wichita|Topeka|Springfield|Peoria|Fort Wayne|Dayton|Toledo|Akron|Provo|Ogden|Lehi|Remote - USA|Remote, USA)\b/;

function segmentIsUs(location: string) {
  if (usExplicit.test(location) || usToken.test(location)) return true;
  if (foreign.test(location)) return false;
  if (usStates.test(location)) return true;
  if (usStateCodes.test(location)) return true;
  if (usCities.test(location)) return true;
  // Bare "Remote" with no country is usually a US company that forgot to say so.
  return /^(?:fully )?remote(?:\s*[-,/|(]\s*(?:anywhere|global|worldwide|north america|americas)\)?)?$/i.test(location);
}

// A job listed in several places ("San Francisco; London", "Remote - US or Canada") counts as US
// when any one of the places is in the US.
export function isUsLocation(rawLocation: string) {
  const location = rawLocation.replace(/\s+/g, " ").trim();
  if (!location) return false;
  const segments = location.split(/\s*(?:;|\||\bor\b|\band\b)\s*/i).map(part => part.trim()).filter(Boolean);
  return segments.some(segmentIsUs);
}

export function workplaceType(location: string): "Remote" | "Hybrid" | "Onsite" | "Unknown" {
  if (/remote|work from home|wfh|anywhere|distributed/i.test(location)) return "Remote";
  if (/hybrid/i.test(location)) return "Hybrid";
  return location ? "Onsite" : "Unknown";
}
