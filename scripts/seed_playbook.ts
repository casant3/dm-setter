import "dotenv/config";
import fs from "node:fs";
import { db } from "../src/db.js";
const pb=JSON.parse(fs.readFileSync("config/playbook.json","utf8"));
const rows=[
  {rule_key:"primary_goal",rule_text:pb.primary_goal,priority:100},
  ...pb.sales_rules.map((x:string,i:number)=>({rule_key:`sales_${i+1}`,rule_text:x,priority:90-i})),
  ...pb.voice_rules.map((x:string,i:number)=>({rule_key:`voice_${i+1}`,rule_text:x,priority:70-i})),
];
const {error}=await db.from("setter_playbook").upsert(rows,{onConflict:"rule_key"});
if(error) throw error;
console.log(`Seeded ${rows.length} playbook rules`);
