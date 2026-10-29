require("dotenv").config();
const { Telegraf } = require("telegraf");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");
const express = require("express");

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Autenticação Híbrida: Usa variáveis de ambiente no Render ou credentials.json no Mac
const authOptions = {
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
};
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  authOptions.credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
} else {
  authOptions.keyFile = "credentials.json";
}
const auth = new google.auth.GoogleAuth(authOptions);
const sheets = google.sheets({ version: "v4", auth });

const systemPrompt = `Você é um assistente financeiro inteligente.
Analise a mensagem do usuário e identifique se a intenção dele é REGISTRAR um novo gasto ou CONSULTAR os gastos já feitos.
Devolva ESTRITAMENTE um objeto JSON, sem nenhum texto fora dele.

Se a intenção for REGISTRAR, devolva o JSON assim:
{"intencao": "registrar", "categoria": "Luz", "valor": 50.00, "descricao": "Conta de luz"}
(Categorias válidas: Luz, Água, Combustível, Alimentação, Internet, Outros)

⚠️ REGRA DE DIVISÃO DE CONTAS: Se o usuário mencionar que dividiu a despesa, você DEVE calcular a fração correta e colocar no campo "valor" APENAS a parte que o usuário vai pagar. 
- Exemplo 1: "Jantei com um amigo e vamos dividir a conta. Deu 230" (O usuário + 1 amigo = 2 pessoas. 230 / 2) -> "valor": 115.00.
- Exemplo 2: "Deu 300 e dividi com 5 amigos" (O usuário + 5 amigos = 6 pessoas. 300 / 6) -> "valor": 50.00.
- Exemplo 3: "Deu 200 dividido para 5 pessoas" (5 pessoas no total. 200 / 5) -> "valor": 40.00.
Quando houver divisão, anote isso na "descricao". Ex: "Jantar (dividido com amigo)".

Se a intenção for CONSULTAR, devolva o JSON assim:
{"intencao": "consultar", "categoria": "Alimentação"}
(Se o usuário perguntar o gasto de uma categoria específica, use a categoria correspondente. Se ele perguntar o total geral, use a categoria "Todas").`;

function obterInicioDoCiclo(dataAtual) {
  let ano = dataAtual.getFullYear();
  let mes = dataAtual.getMonth();

  let primeiroDiaMes = new Date(ano, mes, 1);
  let diaSemana = primeiroDiaMes.getDay();

  let primeiroDiaUtil = new Date(primeiroDiaMes);
  if (diaSemana === 0) primeiroDiaUtil.setDate(2);
  if (diaSemana === 6) primeiroDiaUtil.setDate(3);

  if (dataAtual < primeiroDiaUtil) {
    primeiroDiaMes = new Date(ano, mes - 1, 1);
    diaSemana = primeiroDiaMes.getDay();
    primeiroDiaUtil = new Date(primeiroDiaMes);
    if (diaSemana === 0) primeiroDiaUtil.setDate(2);
    if (diaSemana === 6) primeiroDiaUtil.setDate(3);
  }
  return primeiroDiaUtil;
}

bot.start((ctx) => {
  if (String(ctx.from.id) !== String(process.env.MEU_ID_TELEGRAM)) {
    return ctx.reply(
      "🔒 Acesso negado. Este é um assistente financeiro privado.",
    );
  }
  ctx.reply(
    'Olá! Mande seus gastos para anotar ou me faça perguntas como "Quanto gastei de internet?".',
  );
});

bot.on("text", async (ctx) => {
  // 🔒 TRAVA DE SEGURANÇA: Verifica se quem mandou a mensagem é você
  if (String(ctx.from.id) !== String(process.env.MEU_ID_TELEGRAM)) {
    return ctx.reply(
      "🔒 Acesso negado. Este é um assistente financeiro privado.",
    );
  }

  const userMessage = ctx.message.text;

  try {
    const loadingMsg = await ctx.reply("Pensando... 🤔");

    const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
    const result = await model.generateContent(
      `${systemPrompt}\n\nUsuário: "${userMessage}"`,
    );
    const responseText = result.response
      .text()
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const iaResponse = JSON.parse(responseText);

    const respostaPlanilha = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "Página1!A:D",
    });
    const linhas = respostaPlanilha.data.values || [];
    const inicioDoCiclo = obterInicioDoCiclo(new Date());

    // ==========================================
    // FLUXO A: REGISTRAR GASTO
    // ==========================================
    if (iaResponse.intencao === "registrar") {
      const hoje = new Date();
      const dataFormatada = hoje.toLocaleDateString("pt-BR");

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: "Página1!A:D",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [
            [
              dataFormatada,
              iaResponse.categoria,
              iaResponse.descricao,
              iaResponse.valor,
            ],
          ],
        },
      });

      let somaTotal = 0;
      for (let i = 1; i < linhas.length; i++) {
        const linha = linhas[i];
        if (!linha[0] || !linha[3]) continue;
        const partesData = linha[0].split("/");
        const dataGasto = new Date(
          partesData[2],
          partesData[1] - 1,
          partesData[0],
        );

        if (dataGasto >= inicioDoCiclo) {
          somaTotal += parseFloat(linha[3].toString().replace(",", "."));
        }
      }
      somaTotal += iaResponse.valor;

      const mensagemFinal =
        `✅ **Gasto anotado!**\n\n` +
        `🏷 Categoria: ${iaResponse.categoria}\n` +
        `📝 Descrição: ${iaResponse.descricao}\n` +
        `💸 Valor: R$ ${iaResponse.valor.toFixed(2).replace(".", ",")}\n\n` +
        `📊 **Total da Fatura:** R$ ${somaTotal.toFixed(2).replace(".", ",")}`;

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        mensagemFinal,
        { parse_mode: "Markdown" },
      );
    }

    // ==========================================
    // FLUXO B: CONSULTAR GASTO
    // ==========================================
    else if (iaResponse.intencao === "consultar") {
      let somaConsulta = 0;
      const categoriaBuscada = iaResponse.categoria;

      for (let i = 1; i < linhas.length; i++) {
        const linha = linhas[i];
        if (!linha[0] || !linha[1] || !linha[3]) continue;

        const partesData = linha[0].split("/");
        const dataGasto = new Date(
          partesData[2],
          partesData[1] - 1,
          partesData[0],
        );
        const categoriaPlanilha = linha[1].toLowerCase();

        if (dataGasto >= inicioDoCiclo) {
          if (
            categoriaBuscada === "Todas" ||
            categoriaPlanilha === categoriaBuscada.toLowerCase()
          ) {
            somaConsulta += parseFloat(linha[3].toString().replace(",", "."));
          }
        }
      }

      let msg = "";
      if (categoriaBuscada === "Todas") {
        msg = `📊 Seu gasto **Total** na fatura atual está em: **R$ ${somaConsulta.toFixed(2).replace(".", ",")}**`;
      } else {
        msg = `🔎 Você gastou **R$ ${somaConsulta.toFixed(2).replace(".", ",")}** com *${categoriaBuscada}* neste ciclo.`;
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        msg,
        { parse_mode: "Markdown" },
      );
    }
  } catch (error) {
    console.error(error);
    ctx.reply("Tive um problema ao processar. Tente reformular a frase.");
  }
});

bot.launch();
console.log("Bot conectado à Planilha e rodando!");

// === MINI SERVIDOR WEB PARA O RENDER ===
const app = express();
app.get("/", (req, res) => {
  res.send("Bot Financeiro está online! 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Web rodando na porta ${PORT}`);
});
