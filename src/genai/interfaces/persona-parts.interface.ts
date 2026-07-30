/**
 */
export const PERSONA_PAIRS = {
    // Option 1: Zephyr & Charon (Default)
    'zephyr-charon': {
        description: 'Bright & Informative',
        s1: {
            name: 'Zephyr',
            trait: 'Bright, inquisitive, high-energy. Acts as the curious "everyman" asking questions.',
        },
        s2: {
            name: 'Charon',
            trait: 'Informative, balanced, slightly deeper tone. Provides the answers and context.',
        },
        // "Temperature" of the script: How casual should it be?
        scriptStyle: 'casual-educational',
    },

    // Option 2: Puck & Kore
    'puck-kore': {
        description: 'Expressive & Warm',
        s1: {
            name: 'Puck',
            trait: 'Very expressive, playful, uses humor and interjections ("Whoa!", "No way").',
        },
        s2: {
            name: 'Kore',
            trait: 'Warm, empathetic, uses emotional language ("That is fascinating," "I feel like...").',
        },
        scriptStyle: 'conversational-chatty',
    },

    // Option 3: Charon & Fenrir (The "Serious" Option)
    'charon-fenrir': {
        description: 'Clear & Authoritative',
        s1: {
            name: 'Charon',
            trait: 'Clear, structured, acts as a professional moderator. Keeps things moving.',
        },
        s2: {
            name: 'Fenrir',
            trait: 'Authoritative, deep expertise, formal. Uses precise terminology.',
        },
        scriptStyle: 'professional-analysis', // Directs AI to use fewer "ums"
    },

    // Option 4: Puck & Charon
    'puck-charon': {
        description: 'Dynamic & Clear',
        s1: {
            name: 'Puck',
            trait: 'Dynamic, fast-paced, eager to jump to the next point.',
        },
        s2: {
            name: 'Charon',
            trait: 'Clear, grounding. Keeps Puck from going off-topic.',
        },
        scriptStyle: 'energetic-debate',
    },

    // Option 5: Kore & Fenrir
    'kore-fenrir': {
        description: 'Friendly & Professional',
        s1: {
            name: 'Kore',
            trait: 'Friendly, approachable, smooths over complex topics.',
        },
        s2: {
            name: 'Fenrir',
            trait: "Professional, expert, but polite. Respects Kore's input.",
        },
        scriptStyle: 'npr-style-interview',
    },
};
