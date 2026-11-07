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
