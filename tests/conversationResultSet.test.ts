import { describe, expect, test } from '@jest/globals';

import { createConversationDb, SqliteThreadRepository } from '../src/conversation/repositories/SqliteRepositories';
import { ConversationResultSetRepository } from '../src/resultSets/ConversationResultSetRepository';

describe('ConversationResultSetRepository',()=>{
  test('resolves ordinals and focus deterministically, then cascades with thread deletion',async()=>{const db=createConversationDb(':memory:');const threads=new SqliteThreadRepository(db);await threads.getOrCreate('thread-culture');const repository=new ConversationResultSetRepository(db);repository.create({threadId:'thread-culture',sourceAgent:'culture',sourceAction:'discover',items:[{entityType:'agora.item',entityId:'item_1',displayLabel:'Premier film'},{entityType:'agora.item',entityId:'item_2',displayLabel:'Deuxième film'}]});expect(repository.resolveReference('thread-culture','le deuxième')?.entityId).toBe('item_2');expect(repository.resolveReference('thread-culture','et lui ?')?.entityId).toBe('item_2');await threads.deleteThread('thread-culture');expect(repository.findActive('thread-culture')).toBeNull();db.close();});

  test('keeps only the newest set active for a thread',async()=>{const db=createConversationDb(':memory:');const threads=new SqliteThreadRepository(db);await threads.getOrCreate('thread-newest');const repository=new ConversationResultSetRepository(db);repository.create({threadId:'thread-newest',sourceAgent:'search',sourceAction:'query',items:[{entityType:'search.result',entityId:'old',displayLabel:'Ancien'}]});repository.create({threadId:'thread-newest',sourceAgent:'culture',sourceAction:'discover',items:[{entityType:'agora.item',entityId:'new',displayLabel:'Nouveau'}]});expect(repository.resolveReference('thread-newest','le premier')?.entityId).toBe('new');db.close();});
});
