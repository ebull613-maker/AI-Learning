
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { 
  Search, 
  Volume2, 
  BookMarked, 
  Settings, 
  Brain, 
  MessageCircle, 
  ChevronLeft, 
  Plus, 
  Sparkles,
  RefreshCw,
  X,
  Languages,
  ArrowRightLeft
} from 'lucide-react';

// --- Constants & Types ---

const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'pt', name: 'Portuguese', flag: '🇧🇷' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
];

interface WordEntry {
  id: string;
  word: string;
  definition: string;
  examples: { target: string; native: string }[];
  usage: string;
  imageUrl?: string;
  targetLang: string;
  nativeLang: string;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

// --- Utils ---

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// --- Main Components ---

const App = () => {
  const [nativeLang, setNativeLang] = useState<string>('');
  const [targetLang, setTargetLang] = useState<string>('');
  const [isSetup, setIsSetup] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WordEntry | null>(null);
  const [notebook, setNotebook] = useState<WordEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'search' | 'notebook' | 'study'>('search');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [story, setStory] = useState<string | null>(null);
  const [isFlashcardOpen, setIsFlashcardOpen] = useState(false);
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);

  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.API_KEY }), []);

  useEffect(() => {
    const saved = localStorage.getItem('ai_dict_notebook');
    if (saved) setNotebook(JSON.parse(saved));
    const setup = localStorage.getItem('ai_dict_setup');
    if (setup) {
      const { native, target } = JSON.parse(setup);
      setNativeLang(native);
      setTargetLang(target);
      setIsSetup(true);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('ai_dict_notebook', JSON.stringify(notebook));
  }, [notebook]);

  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
  };

  const handleSetup = () => {
    if (nativeLang && targetLang) {
      localStorage.setItem('ai_dict_setup', JSON.stringify({ native: nativeLang, target: targetLang }));
      setIsSetup(true);
    }
  };

  const playTTS = async (text: string, voice: string = 'Kore') => {
    initAudio();
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Speak clearly: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio && audioContextRef.current) {
        const audioBuffer = await decodeAudioData(decode(base64Audio), audioContextRef.current, 24000, 1);
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContextRef.current.destination);
        source.start();
      }
    } catch (error) {
      console.error("TTS Error:", error);
    }
  };

  const performLookup = async (lookupText: string) => {
    setLoading(true);
    setResult(null);
    setChatHistory([]);
    try {
      const nativeLabel = LANGUAGES.find(l => l.code === nativeLang)?.name;
      const targetLabel = LANGUAGES.find(l => l.code === targetLang)?.name;

      // 1. Fetch Text Info
      const textResponse = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Explain "${lookupText}" from ${targetLabel} into ${nativeLabel}. 
        Return strictly valid JSON with keys: 
        "word" (the query), 
        "definition" (concise native explanation), 
        "examples" (array of {target: string, native: string}), 
        "usage" (fun, friendly, concise note about culture/context/synonyms - like a friend talking).`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              word: { type: Type.STRING },
              definition: { type: Type.STRING },
              examples: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    target: { type: Type.STRING },
                    native: { type: Type.STRING }
                  }
                }
              },
              usage: { type: Type.STRING }
            }
          }
        }
      });

      const parsed = JSON.parse(textResponse.text || '{}');

      // 2. Parallel fetch Image
      const imageResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: `A vibrant, clear conceptual 3D illustration or minimalist vector art representing the concept: "${lookupText}" (${parsed.definition}). Clean background.`,
      });

      let imgUrl = "";
      for (const part of imageResponse.candidates[0].content.parts) {
        if (part.inlineData) {
          imgUrl = `data:image/png;base64,${part.inlineData.data}`;
        }
      }

      const newEntry: WordEntry = {
        ...parsed,
        id: Date.now().toString(),
        imageUrl: imgUrl,
        targetLang,
        nativeLang
      };

      setResult(newEntry);
    } catch (error) {
      console.error("Lookup error", error);
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!chatInput.trim() || !result) return;
    const userMsg = chatInput;
    setChatInput('');
    setChatHistory(prev => [...prev, { role: 'user', text: userMsg }]);

    try {
      const chat = ai.chats.create({
        model: 'gemini-3-flash-preview',
        config: {
          systemInstruction: `You are a helpful AI language tutor. You are explaining the word/phrase "${result.word}" in the context of ${targetLang} to ${nativeLang}. Keep it friendly, casual, and brief.`
        }
      });
      const resp = await chat.sendMessage({ message: userMsg });
      setChatHistory(prev => [...prev, { role: 'model', text: resp.text || "Sorry, I couldn't understand that." }]);
    } catch (e) {
      setChatHistory(prev => [...prev, { role: 'model', text: "Error connecting to AI." }]);
    }
  };

  const generateStory = async () => {
    if (notebook.length < 2) return;
    setLoading(true);
    try {
      const words = notebook.map(n => n.word).join(', ');
      const resp = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Write a very short, funny, and engaging story in ${LANGUAGES.find(l => l.code === targetLang)?.name} using these words: ${words}. Provide a line-by-line translation in ${LANGUAGES.find(l => l.code === nativeLang)?.name}. Keep it under 150 words total.`
      });
      setStory(resp.text || "Could not generate story.");
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // --- UI Sections ---

  if (!isSetup) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-6 flex flex-col items-center justify-center text-white font-sans">
        <div className="bg-white/20 backdrop-blur-lg p-8 rounded-3xl w-full max-w-md shadow-2xl border border-white/30">
          <div className="flex justify-center mb-6">
            <div className="bg-white p-4 rounded-2xl shadow-lg">
              <Languages className="text-indigo-600 w-12 h-12" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-center mb-2">AI Lexicon</h1>
          <p className="text-center text-indigo-100 mb-8">Personalized, visual, and fast learning.</p>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2 opacity-80">Native Language</label>
              <select 
                className="w-full bg-white/10 border border-white/20 rounded-xl p-3 text-white outline-none focus:ring-2 ring-white/50"
                value={nativeLang}
                onChange={(e) => setNativeLang(e.target.value)}
              >
                <option value="" className="text-gray-900">Select Language</option>
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code} className="text-gray-900">{l.flag} {l.name}</option>
                ))}
              </select>
            </div>
            
            <div className="flex justify-center py-2">
              <ArrowRightLeft className="text-white/40" />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2 opacity-80">Target Language</label>
              <select 
                className="w-full bg-white/10 border border-white/20 rounded-xl p-3 text-white outline-none focus:ring-2 ring-white/50"
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
              >
                <option value="" className="text-gray-900">Select Language</option>
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code} className="text-gray-900">{l.flag} {l.name}</option>
                ))}
              </select>
            </div>

            <button 
              onClick={handleSetup}
              disabled={!nativeLang || !targetLang}
              className="w-full bg-white text-indigo-600 font-bold py-4 rounded-xl mt-6 shadow-xl active:scale-95 transition-all disabled:opacity-50"
            >
              Start Learning
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-20 font-sans max-w-md mx-auto relative shadow-2xl overflow-x-hidden">
      {/* Header */}
      <header className="bg-indigo-600 text-white p-6 rounded-b-[2.5rem] shadow-lg sticky top-0 z-40 transition-all">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-yellow-300" />
            AI Lexicon
          </h2>
          <button onClick={() => setIsSetup(false)} className="opacity-70"><Settings className="w-5 h-5"/></button>
        </div>
        
        {activeTab === 'search' && (
          <div className="relative group">
            <input 
              type="text" 
              placeholder="Enter word, phrase or sentence..." 
              className="w-full bg-white/20 border border-white/30 rounded-2xl py-3 px-5 pl-12 text-white placeholder-white/60 outline-none focus:bg-white/30 transition-all"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && performLookup(query)}
            />
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/70" />
            {query && (
              <button 
                onClick={() => performLookup(query)}
                className="absolute right-3 top-1/2 -translate-y-1/2 bg-white text-indigo-600 p-1.5 rounded-lg shadow-md"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        )}

        {activeTab === 'notebook' && <h2 className="text-2xl font-bold">My Notebook</h2>}
        {activeTab === 'study' && <h2 className="text-2xl font-bold">Training Zone</h2>}
      </header>

      {/* Main Content Area */}
      <main className="p-4">
        {activeTab === 'search' && (
          <div className="space-y-6 animate-in fade-in duration-500">
            {loading && !result && (
              <div className="flex flex-col items-center justify-center py-20 space-y-4">
                <div className="w-16 h-16 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                <p className="text-indigo-600 font-medium animate-pulse">Consulting the linguistic spirits...</p>
              </div>
            )}

            {!loading && !result && !query && (
              <div className="text-center py-20 opacity-40">
                <Search className="w-20 h-20 mx-auto mb-4" />
                <p className="text-lg">Search for anything to begin.</p>
              </div>
            )}

            {result && (
              <div className="space-y-4">
                {/* Result Card */}
                <div className="bg-white rounded-3xl p-6 shadow-xl border border-gray-100 relative overflow-hidden">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h1 className="text-3xl font-bold text-gray-900">{result.word}</h1>
                      <p className="text-indigo-600 font-medium text-lg mt-1">{result.definition}</p>
                    </div>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => playTTS(result.word)}
                        className="bg-indigo-50 text-indigo-600 p-3 rounded-2xl hover:bg-indigo-100 active:scale-90 transition-all"
                      >
                        <Volume2 className="w-6 h-6" />
                      </button>
                      <button 
                        onClick={() => {
                          if (notebook.some(n => n.word === result.word)) {
                            setNotebook(notebook.filter(n => n.word !== result.word));
                          } else {
                            setNotebook([...notebook, result]);
                          }
                        }}
                        className={`p-3 rounded-2xl transition-all active:scale-90 ${notebook.some(n => n.word === result.word) ? 'bg-pink-500 text-white shadow-lg' : 'bg-gray-100 text-gray-400'}`}
                      >
                        <BookMarked className="w-6 h-6" />
                      </button>
                    </div>
                  </div>

                  {result.imageUrl && (
                    <div className="mb-6 rounded-2xl overflow-hidden shadow-inner bg-gray-100 aspect-video">
                      <img src={result.imageUrl} alt={result.word} className="w-full h-full object-cover" />
                    </div>
                  )}

                  <div className="space-y-4">
                    <h3 className="font-bold text-gray-800 flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-indigo-500" />
                      Usage & Vibes
                    </h3>
                    <div className="bg-indigo-50/50 p-4 rounded-2xl text-gray-700 leading-relaxed italic border border-indigo-100">
                      "{result.usage}"
                    </div>

                    <div className="space-y-3 mt-4">
                      <h3 className="font-bold text-gray-800">Examples</h3>
                      {result.examples.map((ex, i) => (
                        <div key={i} className="bg-gray-50 p-4 rounded-2xl group border border-transparent hover:border-indigo-200 transition-colors">
                          <div className="flex justify-between items-start">
                            <p className="text-gray-900 font-medium">{ex.target}</p>
                            <button onClick={() => playTTS(ex.target)} className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-indigo-500">
                              <Volume2 className="w-4 h-4" />
                            </button>
                          </div>
                          <p className="text-gray-500 text-sm mt-1">{ex.native}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Chat Trigger */}
                <button 
                  onClick={() => setIsChatOpen(true)}
                  className="w-full bg-indigo-600 text-white p-4 rounded-2xl shadow-lg flex items-center justify-center gap-2 font-bold active:scale-95 transition-all"
                >
                  <MessageCircle className="w-5 h-5" />
                  Ask AI Tutor about this word
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'notebook' && (
          <div className="space-y-4">
            {notebook.length === 0 ? (
              <div className="text-center py-20 opacity-40">
                <BookMarked className="w-20 h-20 mx-auto mb-4" />
                <p>Notebook is empty. Save some words!</p>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <button 
                    onClick={generateStory}
                    className="flex-1 bg-gradient-to-r from-purple-500 to-indigo-600 text-white p-4 rounded-2xl shadow-lg font-bold flex items-center justify-center gap-2 active:scale-95 transition-all"
                  >
                    <Sparkles className="w-5 h-5" />
                    Tell a Story
                  </button>
                </div>

                {story && (
                  <div className="bg-white p-6 rounded-3xl shadow-xl border border-purple-100 relative">
                    <button onClick={() => setStory(null)} className="absolute right-4 top-4 text-gray-400"><X className="w-4 h-4"/></button>
                    <h3 className="text-purple-600 font-bold mb-3 flex items-center gap-2">
                      <Brain className="w-5 h-5" /> Story Memory
                    </h3>
                    <div className="text-gray-800 whitespace-pre-wrap leading-relaxed">{story}</div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3">
                  {notebook.map((item) => (
                    <div 
                      key={item.id} 
                      className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-4">
                        {item.imageUrl && (
                          <div className="w-12 h-12 rounded-xl overflow-hidden bg-gray-100">
                            <img src={item.imageUrl} className="w-full h-full object-cover" />
                          </div>
                        )}
                        <div>
                          <p className="font-bold text-gray-900">{item.word}</p>
                          <p className="text-xs text-gray-500">{item.definition}</p>
                        </div>
                      </div>
                      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => {setResult(item); setActiveTab('search');}} className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg">
                          <Search className="w-4 h-4" />
                        </button>
                        <button onClick={() => setNotebook(notebook.filter(n => n.id !== item.id))} className="p-2 text-pink-500 hover:bg-pink-50 rounded-lg">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'study' && (
          <div className="space-y-8 flex flex-col items-center">
             {notebook.length === 0 ? (
              <div className="text-center py-20 opacity-40">
                <Brain className="w-20 h-20 mx-auto mb-4" />
                <p>Save at least one word to start flashcards.</p>
              </div>
            ) : (
              <div className="w-full px-4 text-center">
                <div className="bg-indigo-100 text-indigo-700 px-4 py-2 rounded-full inline-block font-bold text-sm mb-8">
                  Training {currentCardIndex + 1} / {notebook.length}
                </div>

                <div 
                  className={`relative w-full aspect-[3/4] cursor-pointer transition-all duration-700 [transform-style:preserve-3d] ${isFlipped ? '[transform:rotateY(180deg)]' : ''}`}
                  onClick={() => setIsFlipped(!isFlipped)}
                >
                  {/* Front */}
                  <div className="absolute inset-0 bg-white rounded-[2.5rem] shadow-2xl p-6 flex flex-col items-center justify-center border-4 border-white [backface-visibility:hidden]">
                    <div className="w-full h-2/3 mb-6 rounded-3xl overflow-hidden shadow-lg">
                      <img src={notebook[currentCardIndex].imageUrl} className="w-full h-full object-cover" />
                    </div>
                    <h2 className="text-4xl font-black text-gray-900">{notebook[currentCardIndex].word}</h2>
                    <p className="text-indigo-400 mt-4 font-medium">Click to reveal</p>
                  </div>

                  {/* Back */}
                  <div className="absolute inset-0 bg-indigo-600 rounded-[2.5rem] shadow-2xl p-8 flex flex-col items-center justify-center text-white [backface-visibility:hidden] [transform:rotateY(180deg)]">
                    <div className="text-center space-y-6">
                      <h3 className="text-3xl font-bold border-b border-white/20 pb-4">{notebook[currentCardIndex].definition}</h3>
                      <div className="space-y-4">
                        <p className="text-indigo-100 font-medium italic">"{notebook[currentCardIndex].usage}"</p>
                        <div className="bg-white/10 p-4 rounded-2xl text-left text-sm">
                          <p className="font-bold opacity-70 mb-1">Example:</p>
                          <p>{notebook[currentCardIndex].examples[0].target}</p>
                          <p className="opacity-60">{notebook[currentCardIndex].examples[0].native}</p>
                        </div>
                      </div>
                      <button 
                        onClick={(e) => {e.stopPropagation(); playTTS(notebook[currentCardIndex].word)}}
                        className="bg-white text-indigo-600 p-3 rounded-full shadow-lg"
                      >
                        <Volume2 className="w-6 h-6" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex gap-4 mt-12 w-full">
                  <button 
                    disabled={currentCardIndex === 0}
                    onClick={() => {setCurrentCardIndex(prev => prev - 1); setIsFlipped(false);}}
                    className="flex-1 bg-white text-gray-500 p-4 rounded-2xl font-bold shadow-md disabled:opacity-30 active:scale-95"
                  >
                    Previous
                  </button>
                  <button 
                    disabled={currentCardIndex === notebook.length - 1}
                    onClick={() => {setCurrentCardIndex(prev => prev + 1); setIsFlipped(false);}}
                    className="flex-1 bg-indigo-600 text-white p-4 rounded-2xl font-bold shadow-lg active:scale-95"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Floating Chat Panel */}
      {isChatOpen && result && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full max-w-md h-[80vh] rounded-t-3xl sm:rounded-3xl flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-300">
            <div className="p-4 border-b flex justify-between items-center bg-indigo-50 rounded-t-3xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-600 rounded-full flex items-center justify-center text-white">
                  <Brain className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold text-gray-900">AI Tutor</h3>
                  <p className="text-xs text-indigo-500">Discussing "{result.word}"</p>
                </div>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="p-2 hover:bg-white rounded-full transition-colors"><X/></button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="bg-gray-100 p-4 rounded-2xl rounded-tl-none mr-12 text-gray-700">
                Hi! Ask me anything about how to use "{result.word}" or its meaning. I'm here to help!
              </div>
              {chatHistory.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] p-4 rounded-2xl ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-gray-100 text-gray-800 rounded-tl-none'}`}>
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 border-t flex gap-2">
              <input 
                type="text" 
                className="flex-1 bg-gray-100 rounded-xl px-4 py-2 outline-none focus:ring-2 ring-indigo-500"
                placeholder="Type your question..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              />
              <button 
                onClick={sendMessage}
                className="bg-indigo-600 text-white p-2 px-4 rounded-xl font-bold shadow-lg"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-100 px-8 py-3 flex justify-between items-center z-40 shadow-[0_-10px_30px_rgba(0,0,0,0.05)]">
        <button 
          onClick={() => setActiveTab('search')}
          className={`flex flex-col items-center gap-1 transition-all ${activeTab === 'search' ? 'text-indigo-600 scale-110' : 'text-gray-400'}`}
        >
          <Search className="w-6 h-6" />
          <span className="text-[10px] font-bold">Search</span>
        </button>
        <button 
          onClick={() => setActiveTab('notebook')}
          className={`flex flex-col items-center gap-1 transition-all ${activeTab === 'notebook' ? 'text-indigo-600 scale-110' : 'text-gray-400'}`}
        >
          <BookMarked className="w-6 h-6" />
          <span className="text-[10px] font-bold">Notebook</span>
        </button>
        <button 
          onClick={() => setActiveTab('study')}
          className={`flex flex-col items-center gap-1 transition-all ${activeTab === 'study' ? 'text-indigo-600 scale-110' : 'text-gray-400'}`}
        >
          <Brain className="w-6 h-6" />
          <span className="text-[10px] font-bold">Study</span>
        </button>
      </nav>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
