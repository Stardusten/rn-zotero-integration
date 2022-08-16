import { declareIndexPlugin, ReactRNPlugin, RichTextElementInterface, SetRemType } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import api from 'zotero-api-client';
import { makeCard, makeRem } from '../lib/rem-utils';
import { RichTextElementRemInterface } from '@remnote/plugin-sdk/dist/interfaces';

async function onActivate(plugin: ReactRNPlugin) {

  await plugin.settings.registerStringSetting({
    id: 'zoteroRootDocumentName',
    title: 'Zotero Root Document Name',
    defaultValue: 'Zotero Library',
  });

  await plugin.settings.registerStringSetting({
    id: 'zoteroLeadingChar',
    title: 'Zotero Leading Char',
    defaultValue: '^',
  });

  await plugin.settings.registerStringSetting({
    id: 'zoteroApiKey',
    title: 'Zotero API Key',
    defaultValue: '',
  });

  await plugin.settings.registerDropdownSetting({
    id: 'zoteroUserOrGroup',
    title: 'Zotero User Or Group',
    options: [
      { key: 'User', label: 'User', value: 'user' },
      { key: 'Group', label: 'Group', value: 'group' },
    ],
  });

  await plugin.settings.registerStringSetting({
    id: 'userOrGroupId',
    title: 'Zotero User Or Group Id',
    defaultValue: '',
  });

  // gat zotero api
  const zoteroApiKey = await plugin.settings.getSetting('zoteroApiKey');
  const zoteroUserOrGroup = await plugin.settings.getSetting('zoteroUserOrGroup');
  const userOrGroupId = await plugin.settings.getSetting('userOrGroupId');

  let zoteroApi: any;
  try {
    zoteroApi = api(zoteroApiKey).library(zoteroUserOrGroup, userOrGroupId);
  } catch (error) {
    await plugin.app.toast('Cannot initialize zotero api, please make sure provided arguments are valid in plugin settings.');
    return;
  }

  // make zotero root document
  const zoteroRootDocumentName: string = await plugin.settings.getSetting('zoteroRootDocumentName');
  const zoteroRootDocument = await makeRem(plugin, [zoteroRootDocumentName], null, true);

  // make collection root document
  const collectionsRootDocument = await makeRem(plugin, ['Collections'], zoteroRootDocument._id, true);

  // make items document
  const itemsRootDocument = await makeRem(plugin, ['Items'], zoteroRootDocument._id, true);

  // make creators document
  const creatorsRootDocument = await makeRem(plugin, ['Creators'], zoteroRootDocument._id, false);

  // make tags document
  const tagsRootDocument = await makeRem(plugin, ['Tags'], zoteroRootDocument._id, false);

  await plugin.app.registerCommand({
    id: 'pasteZoteroAnnotations',
    name: 'Paste Zotero Annotations',
    quickCode: 'pza',
    action: async () => {
      // regex that extract annotation link
      // e.g. zotero://open-pdf/library/items/QMVDILXN?page=33&annotation=5MCACPT3
      const regLink = /\[pdf]\((.*?)\)/;
      // regex that extract source text of annotation
      // e.g. "Deng xiao mang, 2018, p. 24"
      const regSrc = /\[(.*?)\](?=\(zotero:\/\/select)/;
      const clipboard = navigator.clipboard;
      const clipboardText = await clipboard.readText();
      const resultRegLink = regLink.exec(clipboardText);
      if (!!resultRegLink) {
        const resultRegSrc = regSrc.exec(clipboardText);
        if (!!resultRegSrc) {
          // if parse successfully
          // insert a link to annotation
          await plugin.editor.insertMarkdown(`[🕮 ${resultRegSrc[1]}](${resultRegLink[1]})`);
          return;
        }
      }
      await plugin.app.toast('Failed to parse data in clipboard: ' + clipboardText);
    },
  });

  await plugin.app.registerCommand({
    id: 'zoteroReset',
    name: 'Zotero Reset',
    action: async () => {
      await plugin.storage.setSynced('zoteroCollectionMap', undefined);
      await plugin.storage.setSynced('zoteroItemsMap', undefined);
    },
  });

  await plugin.app.registerCommand({
    id: 'updateZoteroCollections',
    name: 'Update Zotero Collections',
    description: 'This operation will NOT delete anything.',
    action: async () => {
      // sync collections
      // Map: collection key => { collection, remId }
      let collectionMap = await plugin.storage.getSynced('zoteroCollectionMap');
      if (!collectionMap)
        collectionMap = new Map();
      const responseCollections = await zoteroApi.collections().get();
      const collections = responseCollections.getData();

      for (const collection of collections) {
        // this collection is not exist
        if (!collectionMap.has(collection.key)) {
          // create a rem for it
          const rem = await makeRem(plugin, [collection.name], collectionsRootDocument._id, true);
          // update collectionMap
          collectionMap.set(collection.key, { collection, remId: rem._id });
        } else {
          const { collection: oldCollection, remId } = collectionMap.get(collection.key);
          // this collection is already existed, but need to update
          if (oldCollection.version != collection.version) {
            const rem = (await plugin.rem.findOne(remId))!;
            await rem.setText([collection.name]);
            // update collectionMap
            collectionMap.set(collection.key, { collection, remId });
          }
        }
      }

      // move collections with their parentCollection
      for (const [_, { collection, remId }] of collectionMap) {
        const parentCollection = collection.parentCollection;
        if (parentCollection) {
          const collectionRem = (await plugin.rem.findOne(remId))!;
          const parentCollectionRemId = collectionMap.get(parentCollection).remId;
          await collectionRem.setParent(parentCollectionRemId);
        }
      }

      await plugin.storage.setSynced('zoteroCollectionMap', collectionMap);

      // Map: item key => { item, remId }
      let itemsMap = await plugin.storage.getSynced('zoteroItemsMap');
      if (!itemsMap)
        itemsMap = new Map();

      const responseItems = await zoteroApi.items().top().get({ limit: Number.MAX_SAFE_INTEGER });
      const items = responseItems.getData();
      // console.log(itemsMap);
      // console.log(items);
      for (const item of items) {
        // this item is not exist
        if (!itemsMap.has(item.key)) {
          // create a rem for it
          const rem = await makeRem(plugin, [item.title], itemsRootDocument._id, true);
          // set attributes
          for (const key in item) {
            const value = item[key];
            // skip some useless key
            if (key == 'title' || key == 'key' || key == 'version' || key == 'linkMode'
              || key == 'dateAdded' || key == 'dateModified' || key == 'accessDate')
              continue;
            // skip empty string
            if (value == '')
              continue;
            // skip empty array
            const isArray = Array.isArray(value);
            if (isArray && value.length == 0)
              continue;
            // skip unknown object
            if (!isArray && typeof value == 'object')
              continue;

            if (key == 'creators') {
              // classify creators
              const map = new Map();
              for (const creator of value) {
                // two formats:
                //   1. firstName, lastName
                //   2. name
                let name;
                if (creator.firstName)
                  name = `${creator.firstName} ${creator.lastName}`;
                else name = creator.name;
                if (map.has(creator.creatorType))
                  map.get(creator.creatorType).push(name);
                else map.set(creator.creatorType, [name]);
              }
              for (const [creatorType, creators] of map) {
                const backText = [];
                for (const creator of creators) {
                  const creatorRem = await makeRem(plugin, [creator], creatorsRootDocument._id, false);
                  backText.push({ i: 'q', _id: creatorRem._id } as RichTextElementRemInterface);
                  backText.push(', ');
                }
                await makeCard(plugin, [capitalize(creatorType)], backText.slice(0, -1), rem._id, SetRemType.DESCRIPTOR, 'none');
              }
              continue;
            }

            if (key == 'tags') {
              const backText = [];
              for (const tag of value.map((obj: any) => obj.tag)) {
                const tagRem = await makeRem(plugin, [tag], tagsRootDocument._id, false);
                backText.push({ i: 'q', _id: tagRem._id } as RichTextElementRemInterface);
                backText.push(', ');
              }
              await makeCard(plugin, ['Tags'], backText.slice(0, -1), rem._id, SetRemType.DESCRIPTOR, 'none');
              continue;
            }

            if (key == 'collections') {
              const backText = [];
              for (const collectionKey of value) {
                const record = collectionMap.get(collectionKey);
                backText.push({ i: 'q', _id: record.remId } as RichTextElementRemInterface);
                backText.push(', ');
              }
              await makeCard(plugin, ['Collections'], backText.slice(0, -1), rem._id, SetRemType.DESCRIPTOR, 'none');
              continue;
            }

            await makeCard(plugin, [capitalize(key)], [value], rem._id, SetRemType.DESCRIPTOR, 'none');
          }
          // update itemsMap
          itemsMap.set(item.key, { item, remId: rem._id });
        } else {
          const { item: oldItem, remId } = itemsMap.get(item.key);
          // this item is already existed, but need to update
          if (oldItem.version != item.version) {
            const rem = (await plugin.rem.findOne(remId))!;
            // update title (rem text)
            await rem.setText([item.title]);
            // update attributes
            for (const key in item) {
              const value = item[key];
              // skip some useless key
              if (key == 'title' || key == 'key' || key == 'version' || key == 'linkMode'
                || key == 'dateAdded' || key == 'dateModified' || key == 'accessDate')
                continue;
              // skip empty string
              if (value == '')
                continue;
              // skip empty array
              const isArray = Array.isArray(value);
              if (isArray && value.length == 0)
                continue;
              // skip unknown object
              if (!isArray && typeof value == 'object')
                continue;

              if (key == 'creators') {
                // classify creators
                const map = new Map();
                for (const creator of value) {
                  // two formats:
                  //   1. firstName, lastName
                  //   2. name
                  let name;
                  if (creator.firstName)
                    name = `${creator.firstName} ${creator.lastName}`;
                  else name = creator.name;
                  if (map.has(creator.creatorType))
                    map.get(creator.creatorType).push(name);
                  else map.set(creator.creatorType, [name]);
                }
                for (const [creatorType, creators] of map) {
                  const backText = [];
                  for (const creator of creators) {
                    const creatorRem = await makeRem(plugin, [creator], creatorsRootDocument._id, false);
                    backText.push({ i: 'q', _id: creatorRem._id } as RichTextElementRemInterface);
                    backText.push(', ');
                  }
                  await makeCard(plugin, [capitalize(creatorType)], backText.slice(0, -1), rem._id, SetRemType.DESCRIPTOR, 'none');
                }
                continue;
              }

              if (key == 'tags') {
                const backText = [];
                for (const tag of value.map((obj: any) => obj.tag)) {
                  const tagRem = await makeRem(plugin, [tag], tagsRootDocument._id, false);
                  backText.push({ i: 'q', _id: tagRem._id } as RichTextElementRemInterface);
                  backText.push(', ');
                }
                await makeCard(plugin, ['Tags'], backText.slice(0, -1), rem._id, SetRemType.DESCRIPTOR, 'none');
                continue;
              }

              if (key == 'collections') {
                const backText = [];
                for (const collectionKey of value) {
                  const record = collectionMap.get(collectionKey);
                  backText.push({ i: 'q', _id: record.remId } as RichTextElementRemInterface);
                  backText.push(', ');
                }
                await makeCard(plugin, ['Collections'], backText.slice(0, -1), rem._id, SetRemType.DESCRIPTOR, 'none');
                continue;
              }

              await makeCard(plugin, [capitalize(key)], [value], rem._id, SetRemType.DESCRIPTOR, 'none');
            }
            // update itemsMap
            itemsMap.set(item.key, { item, remId });
          }
        }
        await plugin.storage.setSynced('zoteroItemsMap', itemsMap);
      }
    },
  });
}

/**
 * xyzAbc => XyzAbc
 */
const capitalize = (input: string) => {
  return input.charAt(0).toUpperCase() + input.slice(1);
};

async function onDeactivate(_: ReactRNPlugin) {
}

declareIndexPlugin(onActivate, onDeactivate);
