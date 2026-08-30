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

    const { prompt } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        error: "No prompt received"
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    console.log("GEMINI STATUS:", response.status);
    console.log("GEMINI RESPONSE:", JSON.stringify(data));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "Gemini API error",
        details: data
      });
    }

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") || "";

    return res.status(200).json({
      text
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return res.status(500).json({
      error: error.message || "Server error"
    });
  }
}
