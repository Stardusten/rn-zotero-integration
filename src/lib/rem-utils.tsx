import { RemId, RemType, RichTextInterface, RNPlugin, SetRemType } from '@remnote/plugin-sdk';

export const makeRem = async (plugin: RNPlugin, text: RichTextInterface, parent: RemId | null, isDocument: boolean | null) => {
  let rem = await plugin.rem.findByName(text, parent);
  if (!rem) {
    rem = (await plugin.rem.createRem())!;
    await rem.setText(text);
    await rem.setParent(parent);
    await rem.setIsDocument(isDocument ? isDocument : false);
  }
  return rem;
}

export const makeCard = async (plugin: RNPlugin, text: RichTextInterface, backText: RichTextInterface, parent: RemId | null, type: SetRemType, practiceDirection: "forward" | "backward" | "none" | "both") => {
  let rem = await plugin.rem.findByName(text, parent);
  if (!rem) {
    rem = (await plugin.rem.createRem())!;
    await rem.setText(text);
    await rem.setParent(parent);
  }
  await rem.setBackText(backText);
  await rem.setType(type);
  await rem.setPracticeDirection(practiceDirection);
  return rem;
}