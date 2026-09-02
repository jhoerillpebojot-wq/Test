// api/gemini.js
//
// Fixes vs. the previous version:
// 1. THE BUG: "gemini-3.6-flash" is not a real model id — every call was
//    failing with a 404-ish "invalid response," which the frontend then
//    showed as "AI ERROR: The AI server returned an invalid response."
// 2. Model + fallback chain: pinned to "gemini-3.5-flash" as the primary
//    model, with automatic fallback to "gemini-2.5-flash" then
//    "gemini-flash-latest" if the primary is overloaded (503/429/"high
//    demand"). A demand spike on one model no longer breaks the feature.
// 3. Multi-turn context: accepts an optional `history` array so
//    follow-up questions about a note actually remember earlier turns,
//    instead of every question being answered in isolation.
// 4. Google Search grounding: accepts an optional `useSearch` flag so
//    the AI Study Coach can pull in live web results when a student
//    asks something that goes beyond their note.
// 5. Real error surfacing: a 200 response with no candidates, or a
//    candidate blocked by a safety filter, used to silently turn into
//    an empty string. Now it's reported as an actual error so the UI
//    doesn't have to guess.

export default async function handler(req, res) {
  console.log("GEMINI FUNCTION CALLED");
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      method: req.method
    });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log("API KEY EXISTS:", !!apiKey);
    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing from Vercel"
      });
    }

    const { prompt, systemPrompt, history, useSearch } = req.body || {};
    if (!prompt) {
      return res.status(400).json({
        error: "No prompt received"
      });
    }

    // Turn any prior turns into proper Gemini "contents" entries so the
    // model actually sees the conversation, not just the latest message.
    const contents = [];
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (!turn || !turn.text) continue;
        const role = turn.role === "model" || turn.role === "ai" ? "model" : "user";
        // Trim any single turn defensively so one huge message can't blow
        // out the request; the note body itself is sent in systemPrompt.
        contents.push({ role, parts: [{ text: String(turn.text).slice(0, 4000) }] });
      }
    }
    contents.push({ role: "user", parts: [{ text: String(prompt) }] });

    const requestBody = {
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 1024
      }
    };

    if (systemPrompt) {
      requestBody.systemInstruction = { parts: [{ text: String(systemPrompt) }] };
    }

    if (useSearch) {
      // Grounding with Google Search — lets the model cite live web results
      // instead of only what's in the note or its training data.
      requestBody.tools = [{ google_search: {} }];
    }

    // Try 3.5 Flash first, but automatically fall back to other models if
    // it's overloaded — a single pinned model still goes down whenever
    // *that* model has a demand spike, so on a 503/"overloaded"/"UNAVAILABLE"
    // response we retry against the next one in line instead of failing.
    const modelsToTry = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-flash-latest"];

    let response, data, usedModel;
    for (let i = 0; i < modelsToTry.length; i++) {
      usedModel = modelsToTry[i];
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${usedModel}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(requestBody)
        }
      );

      data = await response.json();
      console.log("GEMINI STATUS:", usedModel, response.status);

      const isOverloaded =
        response.status === 503 ||
        response.status === 429 ||
        /overload|unavailable|high demand/i.test(data?.error?.message || "");

      if (response.ok || !isOverloaded || i === modelsToTry.length - 1) {
        break; // success, a non-overload error (don't waste retries on it), or out of options
      }
      console.log(`${usedModel} overloaded, falling back to ${modelsToTry[i + 1]}`);
    }

    console.log("GEMINI RESPONSE:", JSON.stringify(data));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Gemini API error",
        details: data
      });
    }

    const candidate = data?.candidates?.[0];

    if (!candidate) {
      // Most commonly: the prompt itself was blocked (see data.promptFeedback).
      return res.status(502).json({
        error: "Gemini returned no candidates" +
          (data?.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ""),
        details: data
      });
    }

    if (candidate.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
      return res.status(502).json({
        error: `Response was cut short (${candidate.finishReason})`,
        details: data
      });
    }

    const text = (candidate.content?.parts || [])
      .map(part => part.text || "")
      .join("");

    // If Search grounding was used, hand back the sources it actually
    // drew on so the UI can show them.
    const sources = (candidate.groundingMetadata?.groundingChunks || [])
      .map(chunk => chunk.web ? { title: chunk.web.title, uri: chunk.web.uri } : null)
      .filter(Boolean);

    return res.status(200).json({ text, sources, model: usedModel });
  } catch (error) {
    console.error("SERVER ERROR:", error);
    return res.status(500).json({
      error: error.message || "Server error"
    });
  }
}
