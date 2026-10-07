import {
  backupConversationDatabase,
  createEncryptedConversationBackup,
  decryptBackupFile,
  encryptBackupFile,
  restoreConversationDatabase,
  restoreEncryptedConversationBackup,
  verifyConversationDatabase,
} from '../src/conversation/conversationDbBackup';

type Command =
  | 'backup'
  | 'restore'
  | 'secure-backup'
  | 'secure-restore'
  | 'encrypt-file'
  | 'decrypt-file'
  | 'verify';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`missing_required_option:--${name}`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command === 'verify') {
    console.log(JSON.stringify(verifyConversationDatabase(requiredOption('source')), null, 2));
    return;
  }
  if (command === 'backup') {
    const result = await backupConversationDatabase(
      requiredOption('source'),
      requiredOption('destination'),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'restore') {
    const result = await restoreConversationDatabase(
      requiredOption('source'),
      requiredOption('destination'),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const passphrase = process.env.JARVIS_BACKUP_PASSPHRASE;
  if (command === 'secure-backup') {
    if (!passphrase) throw new Error('missing_environment:JARVIS_BACKUP_PASSPHRASE');
    const result = await createEncryptedConversationBackup(
      requiredOption('source'),
      requiredOption('destination'),
      passphrase
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'secure-restore') {
    if (!passphrase) throw new Error('missing_environment:JARVIS_BACKUP_PASSPHRASE');
    const result = await restoreEncryptedConversationBackup(
      requiredOption('source'),
      requiredOption('destination'),
      passphrase
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'encrypt-file') {
    if (!passphrase) throw new Error('missing_environment:JARVIS_BACKUP_PASSPHRASE');
    await encryptBackupFile(requiredOption('source'), requiredOption('destination'), passphrase);
    return;
  }
  if (command === 'decrypt-file') {
    if (!passphrase) throw new Error('missing_environment:JARVIS_BACKUP_PASSPHRASE');
    await decryptBackupFile(requiredOption('source'), requiredOption('destination'), passphrase);
    return;
  }
  throw new Error(
    'usage: conversation-db <backup|restore|secure-backup|secure-restore|encrypt-file|decrypt-file|verify> --source <path> [--destination <path>]'
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
