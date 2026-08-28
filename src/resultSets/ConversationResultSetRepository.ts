import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type ConversationResultSetItem = { position:number;entityType:string;entityId:string;displayLabel:string };
export type ConversationResultSet = { id:string;threadId:string;sourceAgent:string;sourceAction:string;createdAtMs:number;expiresAtMs:number;focusedPosition:number|null;items:ConversationResultSetItem[] };

export class ConversationResultSetRepository {
  constructor(private readonly db:Database.Database) {}

  create(input:{threadId:string;sourceAgent:string;sourceAction:string;items:Array<Omit<ConversationResultSetItem,'position'>>;ttlMs?:number}):ConversationResultSet {
    const now=Date.now();const id=randomUUID();const items=input.items.slice(0,20).map((item,index)=>({...item,position:index+1}));
    const tx=this.db.transaction(()=>{this.db.prepare('UPDATE conversation_result_sets SET active=0 WHERE thread_id=? AND active=1').run(input.threadId);this.db.prepare(`INSERT INTO conversation_result_sets(id,thread_id,source_agent,source_action,created_at_ms,expires_at_ms,focused_position,active) VALUES(?,?,?,?,?,?,NULL,1)`).run(id,input.threadId,input.sourceAgent,input.sourceAction,now,now+(input.ttlMs??86_400_000));const insert=this.db.prepare(`INSERT INTO conversation_result_set_items(result_set_id,position,entity_type,entity_id,display_label) VALUES(?,?,?,?,?)`);for(const item of items)insert.run(id,item.position,item.entityType,item.entityId,item.displayLabel);});tx();
    return {id,threadId:input.threadId,sourceAgent:input.sourceAgent,sourceAction:input.sourceAction,createdAtMs:now,expiresAtMs:now+(input.ttlMs??86_400_000),focusedPosition:null,items};
  }

  findActive(threadId:string):ConversationResultSet|null { const row=this.db.prepare(`SELECT * FROM conversation_result_sets WHERE thread_id=? AND active=1 AND expires_at_ms>? ORDER BY created_at_ms DESC LIMIT 1`).get(threadId,Date.now()) as Record<string,unknown>|undefined;if(!row)return null;const items=this.db.prepare(`SELECT position,entity_type,entity_id,display_label FROM conversation_result_set_items WHERE result_set_id=? ORDER BY position`).all(row.id) as Array<{position:number;entity_type:string;entity_id:string;display_label:string}>;return{id:String(row.id),threadId:String(row.thread_id),sourceAgent:String(row.source_agent),sourceAction:String(row.source_action),createdAtMs:Number(row.created_at_ms),expiresAtMs:Number(row.expires_at_ms),focusedPosition:row.focused_position===null?null:Number(row.focused_position),items:items.map(item=>({position:item.position,entityType:item.entity_type,entityId:item.entity_id,displayLabel:item.display_label}))}; }

  resolveReference(threadId:string,text:string):ConversationResultSetItem|null { const set=this.findActive(threadId);if(!set)return null;const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();const ordinals:Record<string,number>={premier:1,premiere:1,deuxieme:2,second:2,seconde:2,troisieme:3,quatrieme:4,cinquieme:5};let position:number|null=null;for(const [word,value] of Object.entries(ordinals)){if(new RegExp(`\\b${word}\\b`,'u').test(normalized)){position=value;break;}}if(position===null&&/\b(lui|celui la|celle la|et lui)\b/u.test(normalized))position=set.focusedPosition;if(position===null)return null;const item=set.items.find(candidate=>candidate.position===position)??null;if(item)this.db.prepare('UPDATE conversation_result_sets SET focused_position=? WHERE id=?').run(position,set.id);return item; }
}
