export type BizItem = {id:string; name:string; status:string};
export type BizSnapshot = {
  collectedAt:string; toolCount:number; organization?:string; url?:string;
  departments:{id:string;name:string}[]; department:string;
  capabilities:Record<string, 'available'|'unavailable'|'failed'>;
  warnings:string[]; truncated:boolean;
  kpis:(BizItem & {value:number|null; target:number|null; unit:string; targetMax?:number|null; operator:string; window:number|null; measuredAt:string})[];
  objectives:(BizItem & {keyResults:(BizItem & {kpiId:string;value:number|null;target:number|null})[]})[];
  requests:(BizItem & {krId:string;executor:string})[];
  levers:BizItem[];
};

export type BizPlan = {objectiveId:string; name:string; paused:boolean; pending:boolean; checkin:{status:string;expectedAt:string}|null; levers:(BizItem & {krId:string;description:string;hypothesis:string;assignment:string;requests:BizItem[]})[]; decisions:BizItem[]; truncated:boolean};

export type BizStatus = {connected:boolean; method?:'token'|'oauth'; connectedAt?:string; url?:string; login?:string|null; error?:string};
export type BizTeam = {id:string; slug:string; name:string; description:string; version:number|null; agents:number|null; skills:number|null; localVersion:number|null};
export type BizTeams = {teams:BizTeam[]; error?:string};
/** One read for the page: how the project is connected and, when it is, the teams. */
export type BizOverview = {connection?:BizStatus; teams?:BizTeam[]; error?:string};
export type BizTeamPrepared = {team:{id:string;slug:string;nombre:string;version:number}; bots:{name:string;title:string}[]; skills:string[]; commit:string|null; teamB64:string; teamBaseB64:string; error?:string; bot?:string};
export type BotsPlan = {plan:string[]; created:number; changed:number; deleted:number; removalRevision?:string};
