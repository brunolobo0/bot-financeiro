require("dotenv").config();

async function descobrirModelos() {
  console.log("Consultando os servidores do Google... ⏳");
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;

  try {
    const resposta = await fetch(url);
    const dados = await resposta.json();

    if (dados.error) {
      console.log("Erro na chave:", dados.error.message);
      return;
    }

    // Filtra apenas os modelos de texto e limpa o nome
    const modelos = dados.models
      .filter((m) => m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => m.name.replace("models/", ""));

    console.log("\n🚀 Nomes de modelos válidos e ativos para sua chave:");
    console.log(modelos.join("\n"));
  } catch (erro) {
    console.log("Erro ao conectar:", erro);
  }
}

descobrirModelos();
