// Ready-made requests that agents show as commands (MCP prompts): the user
// picks one in their agent, which follows these steps with the tools.

interface PromptArgument {
  name: string
  description: string
  required?: boolean
}

interface Prompt {
  name: string
  title: string
  description: string
  arguments: PromptArgument[]
  text(args: Record<string, string>): string
}

const PROMPTS: Prompt[] = [
  {
    name: 'clean_up_talking_head',
    title: 'Clean up a talking-head video',
    description: 'Removes fillers and long pauses, adds styled captions and punch-in zooms.',
    arguments: [{ name: 'style', description: 'Caption style id (default cap-highlight)' }],
    text: (a) =>
      [
        'Clean up the talking-head video in Boar:',
        '1. get_project to see the timeline. If the speech is not transcribed, call transcribe.',
        '2. get_transcript mode=words and remove_words with fillers=true. Look at the "maybe" fillers (cioè, tipo, allora, like...) in context and cut only the ones that are padding, by their [start, end].',
        '3. remove_silences with min_silence 0.5.',
        `4. add_captions with style ${a.style || 'cap-highlight'} and emphasis=true.`,
        '5. auto_zoom mode=cuts.',
        '6. get_frame at a few times to check the result, then summarize what you changed (every step can be undone with undo).'
      ].join('\n')
  },
  {
    name: 'voiceover_with_broll',
    title: 'Voiceover with B-roll',
    description: 'Builds an explainer from a recorded voiceover: cleans it up, then covers each part with the matching moments of your recordings, stills, zooms and timelapses.',
    arguments: [
      { name: 'recordings', description: 'Folder or files with the footage (absolute paths)' },
      { name: 'script', description: 'The script with shot notes, if there is one (path or pasted text)' }
    ],
    text: (a) =>
      [
        `Edit an explainer in Boar from the voiceover on the timeline${a.recordings ? ` and the recordings in ${a.recordings}` : ''}:`,
        '1. get_project. If the voiceover is not transcribed, call transcribe. Then remove_silences with min_silence 0.4 and remove_words fillers=true (check the "maybe" fillers in context).',
        `2. get_transcript (sentences) and split it into the parts of the story${a.script ? `, following the script and its shot notes: ${a.script}` : ''}.`,
        '3. media_info on the recordings for their lengths, then skim them with look_at_media: a wide look over each file first, closer looks around what matters.',
        '4. For each part, add_media the moment that shows what the voice says (source_in; length = the sentences it covers; layout full). timelapse for long stretches of work, freeze_frame then set_pan_crop to zoom into code or values while they are explained, spotlight to point at one detail.',
        '5. Cut on sentence boundaries and change shot every 4-8 seconds; keep the voice untouched under the pictures.',
        '6. add_marker at the start of each part (chapters). Captions only if the user asks.',
        '7. get_frame at a few times per part to check, then summarize the edit part by part, with the parts that still need a shot.'
      ].join('\n')
  },
  {
    name: 'make_shorts',
    title: 'Make Shorts from a long video',
    description: 'Finds the best self-contained moments of a long video, proposes them in the Shorts tab and builds the ones the user wants.',
    arguments: [
      { name: 'count', description: 'How many Shorts to propose (default 3)' },
      { name: 'max_seconds', description: 'Maximum length of each Short (default 60)' },
      { name: 'topic', description: 'What the Shorts should be about (optional)' }
    ],
    text: (a) =>
      [
        `Find the ${a.count || '3'} best Shorts (max ${a.max_seconds || '60'} s each) in the long video open in Boar${a.topic ? `, about: ${a.topic}` : ''}.`,
        '1. get_project; if the speech is not transcribed, call transcribe; then get_transcript (sentences).',
        '2. Pick moments that work on their own: a strong hook in the first 3 seconds, one clear idea, a satisfying ending, whole sentences. A Short may join 2-3 ranges if the story stays clear.',
        '3. propose_shorts with a title, a punchy hook line (*key words* highlighted) and a one-line reason for each, best first. They appear in the Shorts tab.',
        '4. Tell the user what you found and ask which ones to make (or make the first if they asked you to go ahead).',
        '5. make_short number=N (framing reframe for a person talking, blurred for screen recordings or wide shots). Then get_frame at 1-2 times to check framing and captions.',
        '6. Tell the user to Render it (Ctrl+M; loudness is normalized to -14 LUFS). For the next one, back_to_long_video with discard=true once they rendered or saved it, then make_short again.'
      ].join('\n')
  },
  {
    name: 'youtube_chapters',
    title: 'YouTube chapters',
    description: 'Reads the video and writes chapter markers plus the chapter list for the YouTube description.',
    arguments: [],
    text: () =>
      [
        'Create YouTube chapters for the video in Boar:',
        '1. get_project; transcribe if needed; get_transcript (sentences).',
        '2. Split the video into 4-10 chapters by topic. The first chapter starts at 0:00; each lasts at least 10 seconds.',
        '3. add_marker for each chapter with a short title.',
        '4. Reply with the list in YouTube format (00:00 Title, one per line) ready to paste in the description.'
      ].join('\n')
  }
]

export const listPrompts = (): object[] =>
  PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments }))

export function getPrompt(name: string, args: Record<string, unknown>): object {
  const prompt = PROMPTS.find((p) => p.name === name)
  if (!prompt) throw new Error(`Unknown prompt "${name}"`)
  const values = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v ?? '')]))
  return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.text(values) } }] }
}
