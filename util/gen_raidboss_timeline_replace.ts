// 아직 멍청하게 작동하는 중
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ConsoleLogger, LogLevelKey } from './console_logger';
import { getCnTable, getKoTable, getTcTable, type Table } from './csv_util';
import { walkDirSync } from './file_utils';
import { XivApi } from './xivapi';

const rootDir = 'ui/raidboss/data';

const _SCRIPT_NAME = path.basename(import.meta.url);
const log = new ConsoleLogger();

// Test mode: limit to 20 files
const TEST_MODE_LIMIT = 20;

const getTargetFiles = (target?: string): string[] => {
  const files: string[] = [];
  const filter = target?.replace(/\.(?:[jt]s|txt)$/, '').split(path.sep).join(path.posix.sep);

  walkDirSync(rootDir, (filename) => {
    // Only process .ts files that have a matching .txt timeline file
    if (filename.endsWith('.ts') && !filename.includes('00-misc')) {
      const timelinePath = filename.replace(/\.ts$/, '.txt');
      if (fs.existsSync(timelinePath)) {
        if (filter === undefined || filter === '' || filename.endsWith(`${filter}.ts`))
          files.push(filename);
      }
    }
  });

  if (target !== undefined && files.length === 0)
    log.fatalError(`Could not find raidboss file for ${target}`);
  return files.sort();
};

const localesFromXivApi = ['de', 'fr', 'ja'] as const;
const localesFromGitHub = ['cn', 'ko', 'tc'] as const;
type Locale = typeof localesFromXivApi[number] | typeof localesFromGitHub[number];
const allLocales: Locale[] = [...localesFromXivApi, ...localesFromGitHub];

type ActionRow = {
  row_id: number;
  fields: {
    Name?: string;
    'Name@de'?: string;
    'Name@fr'?: string;
    'Name@ja'?: string;
  };
};

type BNpcNameRow = {
  row_id: number;
  fields: {
    Singular?: string;
    'Singular@de'?: string;
    'Singular@fr'?: string;
    'Singular@ja'?: string;
  };
};

interface LocaleData {
  enActionMap: Map<string, number[]>;
  enBnpcMap: Map<string, number[]>;
  allLocaleActionMaps: Map<Locale, Map<number, string>>;
  allLocaleBnpcMaps: Map<Locale, Map<number, string>>;
}

interface ExistingTranslations {
  replaceSync: Map<string, string>;
  replaceText: Map<string, string>;
  syncKeyOrder: string[]; // Preserve original key order
  textKeyOrder: string[]; // Preserve original key order
  hasMissingTranslations: boolean; // Whether 'missingTranslations': true existed
}

// Parse existing timelineReplace from file content
const parseExistingTimelineReplace = (
  content: string,
): Map<Locale, ExistingTranslations> => {
  const result = new Map<Locale, ExistingTranslations>();

  // Find the timelineReplace array - use a more flexible pattern
  const timelineReplaceMatch = /timelineReplace:\s*\[([\s\S]*?)\n\s*\],?/.exec(content);
  if (
    !timelineReplaceMatch || timelineReplaceMatch[1] === undefined || timelineReplaceMatch[1] === ''
  )
    return result;

  const arrayContent = timelineReplaceMatch[1];

  // Find each locale block by locating 'locale': and then finding the complete object
  const localeStartPattern = /\{\s*\n?\s*'locale':\s*'(\w+)'/g;

  for (const localeMatch of arrayContent.matchAll(localeStartPattern)) {
    const locale = localeMatch[1] as Locale;
    const blockStart = localeMatch.index ?? 0;

    // Find the matching closing brace by counting braces
    let braceCount = 0;
    let blockEnd = blockStart;
    let inString = false;
    let escapeNext = false;

    for (let i = blockStart; i < arrayContent.length; i++) {
      const char = arrayContent[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '\'' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') {
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            blockEnd = i + 1;
            break;
          }
        }
      }
    }

    const blockContent = arrayContent.slice(blockStart, blockEnd);

    // Check if this block has missingTranslations: true
    const hasMissingTranslations = /'missingTranslations':\s*true/.test(blockContent);

    const syncTranslations = new Map<string, string>();
    const textTranslations = new Map<string, string>();
    const syncKeyOrder: string[] = [];
    const textKeyOrder: string[] = [];

    // Parse replaceSync - handle both single-line and multi-line formats
    const syncMatch = /'replaceSync':\s*\{([\s\S]*?)\}/m.exec(blockContent);
    if (syncMatch && syncMatch[1] !== undefined && syncMatch[1] !== '') {
      // Match key-value pairs, handling escaped quotes
      const kvRegex = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
      for (const kv of syncMatch[1].matchAll(kvRegex)) {
        const key = (kv[1] ?? '').replace(/\\'/g, `'`);
        const val = (kv[2] ?? '').replace(/\\'/g, `'`);
        syncTranslations.set(key, val);
        syncKeyOrder.push(key);
      }
    }

    // Parse replaceText
    const textMatch = /'replaceText':\s*\{([\s\S]*?)\}/m.exec(blockContent);
    if (textMatch && textMatch[1] !== undefined && textMatch[1] !== '') {
      const kvRegex = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
      for (const kv of textMatch[1].matchAll(kvRegex)) {
        const key = (kv[1] ?? '').replace(/\\'/g, `'`);
        const val = (kv[2] ?? '').replace(/\\'/g, `'`);
        textTranslations.set(key, val);
        textKeyOrder.push(key);
      }
    }

    if (syncTranslations.size > 0 || textTranslations.size > 0) {
      result.set(locale, {
        replaceSync: syncTranslations,
        replaceText: textTranslations,
        syncKeyOrder: syncKeyOrder,
        textKeyOrder: textKeyOrder,
        hasMissingTranslations: hasMissingTranslations,
      });
    }
  }
  return result;
};

const replaceGermanGrammarTags = (name: string): string => {
  return name.replace(/\[t\]/g, '(?:der|die|das)')
    .replace(/\[a\]/g, '(?:e|er|es|en)')
    .replace(/\[A\]/g, '(?:e|er|es|en)')
    .replace(/\[p\]/g, '')
    .trim();
};

const fetchLocaleData = async (): Promise<LocaleData> => {
  log.info('Fetching Action and BNpcName data for all locales...');
  const xivApi = new XivApi(null, log);

  const actionFields = ['Name', ...localesFromXivApi.map((l) => `Name@${l}`)];
  const bnpcFields = ['Singular', ...localesFromXivApi.map((l) => `Singular@${l}`)];

  const [
    actionData,
    bnpcData,
    koActionTable,
    cnActionTable,
    tcActionTable,
    koBnpcTable,
    cnBnpcTable,
    tcBnpcTable,
  ] = await Promise.all([
    xivApi.queryApi('Action', actionFields),
    xivApi.queryApi('BNpcName', bnpcFields),
    getKoTable('Action', ['#', 'Name'], ['#', 'Name']),
    getCnTable('Action', ['#', 'Name'], ['#', 'Name']),
    getTcTable('Action', ['#', 'Name'], ['#', 'Name']),
    getKoTable('BNpcName', ['#', 'Singular'], ['#', 'Singular']),
    getCnTable('BNpcName', ['#', 'Singular'], ['#', 'Singular']),
    getTcTable('BNpcName', ['#', 'Singular'], ['#', 'Singular']),
  ]);

  const githubActionTables: { [locale: string]: Table<'#', 'Name'> } = {
    cn: cnActionTable,
    ko: koActionTable,
    tc: tcActionTable,
  };

  const githubBnpcTables: { [locale: string]: Table<'#', 'Singular'> } = {
    cn: cnBnpcTable,
    ko: koBnpcTable,
    tc: tcBnpcTable,
  };

  // English Action Map
  const enActionMap = new Map<string, number[]>();
  for (const row of actionData as ActionRow[]) {
    const name = row.fields.Name?.toLowerCase();
    if (name !== undefined && name !== '' && !name.startsWith('_rsv_')) {
      const ids = enActionMap.get(name) ?? [];
      ids.push(row.row_id);
      enActionMap.set(name, ids);
    }
  }

  // English BNpc Map
  const enBnpcMap = new Map<string, number[]>();
  for (const row of bnpcData as BNpcNameRow[]) {
    const name = row.fields.Singular?.toLowerCase();
    if (name !== undefined && name !== '') {
      const ids = enBnpcMap.get(name) ?? [];
      ids.push(row.row_id);
      enBnpcMap.set(name, ids);
    }
  }

  const allLocaleActionMaps = new Map<Locale, Map<number, string>>();
  const allLocaleBnpcMaps = new Map<Locale, Map<number, string>>();

  // XIVAPI Locales
  for (const locale of localesFromXivApi) {
    const actionField = `Name@${locale}` as keyof ActionRow['fields'];
    const bnpcField = `Singular@${locale}` as keyof BNpcNameRow['fields'];

    const actionMap = new Map<number, string>();
    for (const row of actionData as ActionRow[]) {
      const val = row.fields[actionField];
      if (typeof val === 'string' && val.trim() !== '') {
        actionMap.set(row.row_id, val.trim());
      }
    }
    allLocaleActionMaps.set(locale, actionMap);

    const bnpcMap = new Map<number, string>();
    for (const row of bnpcData as BNpcNameRow[]) {
      const val = row.fields[bnpcField];
      if (typeof val === 'string' && val.trim() !== '') {
        const name = locale === 'de' ? replaceGermanGrammarTags(val) : val.trim();
        bnpcMap.set(row.row_id, name);
      }
    }
    allLocaleBnpcMaps.set(locale, bnpcMap);
  }

  // GitHub Locales
  for (const locale of localesFromGitHub) {
    const actionTable = githubActionTables[locale];
    const bnpcTable = githubBnpcTables[locale];

    if (actionTable !== undefined) {
      const actionMap = new Map<number, string>();
      for (const [idStr, row] of Object.entries(actionTable)) {
        const name = row['Name'];
        if (name !== undefined && name.trim() !== '')
          actionMap.set(parseInt(idStr), name.trim());
      }
      allLocaleActionMaps.set(locale, actionMap);
    }

    if (bnpcTable !== undefined) {
      const bnpcMap = new Map<number, string>();
      for (const [idStr, row] of Object.entries(bnpcTable)) {
        const name = row['Singular'];
        if (name !== undefined && name.trim() !== '')
          bnpcMap.set(parseInt(idStr), name.trim());
      }
      allLocaleBnpcMaps.set(locale, bnpcMap);
    }
  }

  return { enActionMap, enBnpcMap, allLocaleActionMaps, allLocaleBnpcMaps };
};

// Extract base name and suffix from timeline names
const extractNameParts = (
  name: string,
): { prefix: string; baseName: string; suffix: string } => {
  const prefixMatch = name.match(/^(Clone \d+ )/);
  const prefix = prefixMatch?.[1] ?? '';
  const nameWithoutPrefix = prefix !== '' ? name.slice(prefix.length) : name;

  const suffixPattern =
    /(\s+\d+)?(\s+x\d+)?(\s+\([^)]+\))?(\s+(?:Left|Right|Northeast|Northwest|Southeast|Southwest)(?:\/\w+)?)?(\?)?$/i;
  const suffixMatch = nameWithoutPrefix.match(suffixPattern);

  if (suffixMatch && suffixMatch[0] !== '') {
    const suffix = suffixMatch[0];
    const baseName = nameWithoutPrefix.slice(0, -suffix.length);
    return { prefix, baseName, suffix };
  }

  return { prefix: prefix, baseName: nameWithoutPrefix, suffix: '' };
};

const processFile = (
  triggersFile: string,
  localeData: LocaleData,
  padding: number,
): boolean => {
  const { enActionMap, enBnpcMap, allLocaleActionMaps, allLocaleBnpcMaps } = localeData;

  const timelinePath = triggersFile.replace(/\.[jt]s$/, '.txt');
  if (!fs.existsSync(timelinePath)) {
    return false;
  }

  const content = fs.readFileSync(triggersFile, 'utf8');
  const timelineContent = fs.readFileSync(timelinePath, 'utf8');

  // Parse existing translations from file
  const existingTranslations = parseExistingTimelineReplace(content);

  // Get action IDs from triggers
  const getActionIdsFromContent = (): number[] => {
    const startsUsingRegex =
      /type:\s*'StartsUsing'[\s\S]*?netRegex:\s*\{[\s\S]*?id:\s*(?:['"]([0-9A-Fa-f]+)['"]|\[((?:['"][0-9A-Fa-f]+['"],?\s*)+)\])/g;

    const ids: number[] = [];
    let match = startsUsingRegex.exec(content);
    while (match !== null) {
      if (match[1] !== undefined) {
        ids.push(parseInt(match[1], 16));
      } else if (match[2] !== undefined) {
        const list = match[2].replace(/['"]/g, '').split(',').map((s) => s.trim());
        for (const id of list) {
          if (id !== '')
            ids.push(parseInt(id, 16));
        }
      }
      match = startsUsingRegex.exec(content);
    }
    return ids;
  };

  const triggerIds = getActionIdsFromContent();
  if (triggerIds.length === 0) {
    return false;
  }

  const minId = Math.min(...triggerIds);
  const maxId = Math.max(...triggerIds);
  const searchMinId = minId - padding;
  const searchMaxId = maxId + padding;

  // Extract timeline names
  const timelineNames = new Set<string>();
  const nameRegex = /"([^"]+)"/g;
  let nameMatch = nameRegex.exec(timelineContent);
  while (nameMatch !== null) {
    if (nameMatch[1] !== undefined) {
      timelineNames.add(nameMatch[1]);
    }
    nameMatch = nameRegex.exec(timelineContent);
  }

  // Find the best matching action ID for a given name
  const findBestActionId = (name: string): number => {
    const candidateIds = enActionMap.get(name.toLowerCase());
    if (candidateIds === undefined)
      return -1;

    let bestId = -1;
    let minDistance = Number.MAX_SAFE_INTEGER;

    for (const id of candidateIds) {
      if (id < searchMinId || id > searchMaxId)
        continue;

      let distance = 0;
      if (id < minId) {
        distance = minId - id;
      } else if (id > maxId) {
        distance = id - maxId;
      }

      if (distance < minDistance) {
        minDistance = distance;
        bestId = id;
      }
    }

    return bestId;
  };

  // Collect English keys that need translation
  const englishTextKeys = new Set<string>();
  for (const timelineName of timelineNames) {
    if (timelineName.startsWith('--') && timelineName.endsWith('--'))
      continue;

    let bestId = findBestActionId(timelineName);
    if (bestId !== -1) {
      englishTextKeys.add(timelineName);
      continue;
    }

    const { baseName } = extractNameParts(timelineName);
    if (baseName !== '' && baseName !== timelineName) {
      bestId = findBestActionId(baseName);
      if (bestId !== -1) {
        englishTextKeys.add(baseName);
      }
    }
  }

  // Extract sources for replaceSync
  const sources = new Set<string>();
  const syncFieldNames = ['source', 'name', 'target'];
  const sourceRegex = new RegExp(
    `(?:${syncFieldNames.join('|')}):\\s*(?:['"]([^'"]+)['"]|\\[((?:['"][^'"]+['"],?\\s*)+)\\])`,
    'g',
  );

  let sourceMatch = sourceRegex.exec(content);
  while (sourceMatch !== null) {
    if (sourceMatch[1] !== undefined) {
      sources.add(sourceMatch[1]);
    } else if (sourceMatch[2] !== undefined) {
      const list = sourceMatch[2].replace(/['"]/g, '').split(',').map((s) => s.trim());
      for (const s of list) {
        if (s !== '')
          sources.add(s);
      }
    }
    sourceMatch = sourceRegex.exec(sourceRegex.source);
  }

  // Extract from timeline file as well
  const timelineSourceRegex = new RegExp(
    `(?:${syncFieldNames.join('|')}):\\s*['"]([^'"]+)['"]`,
    'g',
  );
  let timelineSourceMatch = timelineSourceRegex.exec(timelineContent);
  while (timelineSourceMatch !== null) {
    if (timelineSourceMatch[1] !== undefined) {
      sources.add(timelineSourceMatch[1]);
    }
    timelineSourceMatch = timelineSourceRegex.exec(timelineContent);
  }

  // Deduplicate sources by case-insensitive comparison (keep first alphabetically)
  const seenSources = new Map<string, string>();
  for (const s of sources) {
    const lower = s.toLowerCase();
    if (!seenSources.has(lower) || s < (seenSources.get(lower) ?? '')) {
      seenSources.set(lower, s);
    }
  }
  const uniqueSources = new Set(seenSources.values());

  if (englishTextKeys.size === 0 && uniqueSources.size === 0) {
    return false;
  }

  // Generate translations for each locale
  const localeBlocks: string[] = [];

  for (const locale of allLocales) {
    const localeActionMap = allLocaleActionMaps.get(locale);
    const localeBnpcMap = allLocaleBnpcMaps.get(locale);
    if (!localeActionMap || !localeBnpcMap)
      continue;

    // Get existing translations for this locale
    const existingLocaleTranslations = existingTranslations.get(locale);
    const existingSyncMap = existingLocaleTranslations?.replaceSync;
    const existingTextMap = existingLocaleTranslations?.replaceText;

    // Generate replaceText - merge with existing translations
    const replaceText: { [key: string]: string } = {};

    // Keep all existing replaceText entries (no deletion)
    if (existingTextMap) {
      for (const [key, value] of existingTextMap) {
        replaceText[key] = value;
      }
    }

    // Then add/update with new translations from API
    for (const enKey of englishTextKeys) {
      const bestId = findBestActionId(enKey);
      if (bestId !== -1) {
        const locName = localeActionMap.get(bestId);
        if (locName !== undefined && enKey.trim() !== '') {
          replaceText[enKey] = locName;
        }
      }
    }

    // Generate replaceSync
    const replaceSync: { [key: string]: string } = {};

    for (const source of uniqueSources) {
      const ids = enBnpcMap.get(source.toLowerCase());
      if (ids === undefined)
        continue;

      const existingValue = existingSyncMap?.get(source);

      const candidates = new Set<string>();
      for (const id of ids) {
        const locName = localeBnpcMap.get(id);
        if (locName !== undefined) {
          candidates.add(locName);
        }
      }

      if (candidates.size > 0) {
        // Deduplicate by case-insensitive comparison
        const seen = new Map<string, string>();
        for (const c of candidates) {
          const lower = c.toLowerCase();
          if (!seen.has(lower) || c < (seen.get(lower) ?? '')) {
            seen.set(lower, c);
          }
        }
        const uniqueCandidates = Array.from(seen.values()).sort();

        if (uniqueCandidates.length === 1) {
          replaceSync[source] = uniqueCandidates[0] ?? '';
        } else if (existingValue !== undefined) {
          // Multiple candidates but existing translation exists - keep existing
          log.alert(
            `${triggersFile}: Multiple candidates for '${source}' in ${locale}: ${
              uniqueCandidates.join(', ')
            }`,
          );
          log.alert(`         Using existing translation: '${existingValue}'`);
          replaceSync[source] = existingValue;
        } else {
          // Multiple candidates and no existing - output alternation for manual review
          log.alert(
            `${triggersFile}: Multiple candidates for '${source}' in ${locale}: ${
              uniqueCandidates.join(', ')
            }`,
          );
          log.alert(`         No existing translation found. Manual review required.`);
          replaceSync[source] = `(?:${uniqueCandidates.join('|')})`;
        }
      } else if (existingValue !== undefined) {
        // No candidates found but existing translation exists - keep it
        replaceSync[source] = existingValue;
      }
    }

    if (Object.keys(replaceText).length === 0 && Object.keys(replaceSync).length === 0)
      continue;

    // Build output block for this locale
    const lines: string[] = [];
    lines.push('    {');
    lines.push(`      'locale': '${locale}',`);

    // Only add 'missingTranslations': true if:
    // 1. This is a new locale block (no existing translations), OR
    // 2. The existing block already had 'missingTranslations': true
    const isNewBlock = existingLocaleTranslations === undefined;
    const hadMissingTranslations = existingLocaleTranslations?.hasMissingTranslations ?? false;
    if (isNewBlock || hadMissingTranslations) {
      lines.push(`      'missingTranslations': true,`);
    }

    if (Object.keys(replaceSync).length > 0) {
      lines.push(`      'replaceSync': {`);
      // Output existing keys first in original order, then new keys
      const existingSyncKeyOrder = existingLocaleTranslations?.syncKeyOrder ?? [];
      const existingSyncKeys = new Set(existingSyncKeyOrder);
      const newSyncKeys = Object.keys(replaceSync).filter((k) => !existingSyncKeys.has(k));

      for (const en of [...existingSyncKeyOrder, ...newSyncKeys]) {
        const loc = replaceSync[en];
        if (loc === undefined)
          continue;
        const escapedEn = en.replace(/'/g, `\\'`).replace(/\$/g, '$$$$');
        const escapedLoc = loc.replace(/'/g, `\\'`).replace(/\$/g, '$$$$');
        lines.push(`        '${escapedEn}': '${escapedLoc}',`);
      }
      lines.push(`      },`);
    }

    if (Object.keys(replaceText).length > 0) {
      lines.push(`      'replaceText': {`);
      // Output existing keys first in original order, then new keys
      const existingTextKeyOrder = existingLocaleTranslations?.textKeyOrder ?? [];
      const existingTextKeys = new Set(existingTextKeyOrder);
      const newTextKeys = Object.keys(replaceText).filter((k) => !existingTextKeys.has(k));
      const replaceTextKeys = Object.keys(replaceText);

      for (const en of [...existingTextKeyOrder, ...newTextKeys]) {
        const loc = replaceText[en];
        if (loc === undefined)
          continue;

        // Check for overlapping keys
        const suffixCollisions = new Set<string>();
        const prefixCollisions = new Set<string>();

        for (const otherKey of replaceTextKeys) {
          if (otherKey === en)
            continue;

          if (otherKey.endsWith(en)) {
            // en is a suffix of otherKey, e.g. "Ice" in "Fire Ice"
            // The character before "Ice" is the collision
            const charBefore = otherKey[otherKey.length - en.length - 1];
            if (charBefore !== undefined)
              prefixCollisions.add(charBefore);
          }

          if (otherKey.startsWith(en)) {
            // en is a prefix of otherKey, e.g. "Ice" in "Ice Fire"
            // The character after "Ice" is the collision
            const charAfter = otherKey[en.length];
            if (charAfter !== undefined)
              suffixCollisions.add(charAfter);
          }

          // Also handle middle matches if needed, but usually Cactbot keys are phrases
          // For now, let's stick to prefix/suffix overlaps as they are most common errors
          // Middle matches might be too aggressive (e.g. "is" in "Mist")
        }

        let key = en;

        // Helper to escape chars for regex character class
        const escapeChar = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        if (prefixCollisions.size > 0 && suffixCollisions.size > 0) {
          const pre = [...prefixCollisions].map(escapeChar).join('');
          const suf = [...suffixCollisions].map(escapeChar).join('');
          key = `(?<![${pre}])${en}(?![${suf}])`;
        } else if (prefixCollisions.size > 0) {
          const pre = [...prefixCollisions].map(escapeChar).join('');
          key = `(?<![${pre}])${en}`;
        } else if (suffixCollisions.size > 0) {
          const suf = [...suffixCollisions].map(escapeChar).join('');
          key = `${en}(?![${suf}])`;
        }

        const escapedKey = key.replace(/'/g, `\\'`).replace(/\$/g, '$$$$');
        const escapedLoc = loc.replace(/'/g, `\\'`).replace(/\$/g, '$$$$');
        lines.push(`        '${escapedKey}': '${escapedLoc}',`);
      }
      lines.push(`      },`);
    }

    lines.push('    },');
    localeBlocks.push(lines.join('\r\n'));
  }

  if (localeBlocks.length === 0) {
    return false;
  }

  // Build new timelineReplace block
  const newBlock = `\r\n  timelineReplace: [\r\n${localeBlocks.join('\r\n')}\r\n  ],`;

  // Update file content
  let newContent = content;
  const replaceRegex = /(\s*)timelineReplace:\s*\[[\s\S]*?\],/;
  const insertRegex = /(};\s*\n\s*export default triggerSet;)/;

  if (replaceRegex.test(content)) {
    newContent = content.replace(replaceRegex, newBlock);
  } else if (insertRegex.test(content)) {
    newContent = content.replace(insertRegex, `${newBlock}\r\n$1`);
  } else {
    return false;
  }

  if (newContent === content) {
    return false;
  }

  fs.writeFileSync(triggersFile, newContent, 'utf8');
  return true;
};

const genRaidbossTimelineReplace = async (
  logLevel: LogLevelKey,
  target?: string,
): Promise<void> => {
  log.setLogLevel(logLevel);
  log.info(`Starting processing for ${_SCRIPT_NAME}`);

  try {
    // Determine which files to process
    let filesToProcess = getTargetFiles(target);

    // TEST MODE: Limit to first 20 files
    if (target === undefined && filesToProcess.length > TEST_MODE_LIMIT) {
      log.info(`TEST MODE: Limiting to ${TEST_MODE_LIMIT} files out of ${filesToProcess.length}`);
      filesToProcess = filesToProcess.slice(0, TEST_MODE_LIMIT);
    }

    if (filesToProcess.length > 1)
      log.info(`Processing ${filesToProcess.length} raidboss files...`);

    // Fetch locale data once
    const localeData = await fetchLocaleData();
    const padding = 100;

    let updatedCount = 0;
    let skippedCount = 0;

    for (const file of filesToProcess) {
      try {
        const updated = processFile(file, localeData, padding);
        if (updated) {
          log.info(`Updated: ${file}`);
          updatedCount++;
        } else {
          skippedCount++;
        }
      } catch (err) {
        log.nonFatalError(`Error processing ${file}:`);
        if (err instanceof Error) {
          log.printNoHeader(err.message);
          log.debug(err.stack ?? '');
        } else {
          log.printNoHeader(String(err));
        }
      }
    }

    log.successDone(`Updated: ${updatedCount}, Skipped: ${skippedCount}`);
  } catch (err) {
    if (err instanceof Error) {
      log.fatalError(`Fatal initialization error: ${err.message}\n${err.stack ?? ''}`);
    } else {
      log.fatalError(`Fatal initialization error: ${String(err)}`);
    }
  }
};

export default genRaidbossTimelineReplace;

if (
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  void genRaidbossTimelineReplace('alert', args[0]);
}
