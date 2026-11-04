require("dotenv").config();
const { Telegraf } = require("telegraf");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");
const express = require("express");

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
Analise a mensagem do usuário e identifique se a intenção é REGISTRAR um gasto ou CONSULTAR.
Devolva ESTRITAMENTE um objeto JSON.

Se REGISTRAR, devolva neste formato:
{"intencao": "registrar", "categoria": "Eletrônicos", "valor_total": 300.00, "descricao": "Microondas", "parcelado": true, "qtd_parcelas": 3}
(Categorias válidas: Luz, Água, Combustível, Alimentação, Internet, Outros)

⚠️ REGRAS:
- Se dividiu a conta, o "valor_total" é SÓ a parte do usuário.
- Se for parcelado, "parcelado": true, extraia "qtd_parcelas", e "valor_total" é o valor INTEGRAL.

Se CONSULTAR:
{"intencao": "consultar", "categoria": "Alimentação", "ciclo": "atual"}
(Se o usuário perguntar da "próxima fatura" ou "mês que vem", use "ciclo": "proximo")`;

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

function obterFimDoCiclo(inicioDoCiclo) {
  let ano = inicioDoCiclo.getFullYear();
  let mes = inicioDoCiclo.getMonth();
  let primeiroDiaProximoMes = new Date(ano, mes + 1, 1);
  let diaSemana = primeiroDiaProximoMes.getDay();
  let primeiroDiaUtil = new Date(primeiroDiaProximoMes);
  if (diaSemana === 0) primeiroDiaUtil.setDate(2);
  if (diaSemana === 6) primeiroDiaUtil.setDate(3);
  return primeiroDiaUtil;
}

function converterValorSeguro(texto) {
  if (!texto) return 0;
  let stringVal = texto.toString().trim();
  if (stringVal.includes(",")) {
    return parseFloat(stringVal.replace(/\./g, "").replace(",", ".")) || 0;
  } else {
    return parseFloat(stringVal.replace(/[^\d.-]/g, "")) || 0;
  }
}

bot.start((ctx) => {
  if (String(ctx.from.id) !== String(process.env.MEU_ID_TELEGRAM))
    return ctx.reply("🔒 Acesso negado.");
  ctx.reply("Olá! Mande seus gastos, sejam eles à vista ou parcelados.");
});

bot.on("text", async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.MEU_ID_TELEGRAM))
    return ctx.reply("🔒 Acesso negado.");

  const userMessage = ctx.message.text;

  try {
    const loadingMsg = await ctx.reply("Calculando... 🤔");

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });
    const result = await model.generateContent(
      `${systemPrompt}\n\nUsuário: "${userMessage}"`,
    );
    const iaResponse = JSON.parse(result.response.text());

    const inicioAtual = obterInicioDoCiclo(new Date());
    const fimAtual = obterFimDoCiclo(inicioAtual);
    const inicioProximo = fimAtual;
    const fimProximo = obterFimDoCiclo(inicioProximo);

    if (iaResponse.intencao === "registrar") {
      const isParcelado = iaResponse.parcelado;
      const parcelas = parseInt(iaResponse.qtd_parcelas) || 1;
      const valorTotal = parseFloat(iaResponse.valor_total) || 0;
      const valorParcela = valorTotal / parcelas;

      const linhasParaInserir = [];
      const hoje = new Date();

      for (let i = 0; i < parcelas; i++) {
        let dataGasto = new Date(
          hoje.getFullYear(),
          hoje.getMonth() + i + 1,
          10,
        );
        const dataFormatada = dataGasto.toLocaleDateString("pt-BR");
        const tipo = isParcelado ? "Parcelado" : "Única";
        const desc = isParcelado
          ? `${iaResponse.descricao} (Parcela ${i + 1}/${parcelas})`
          : iaResponse.descricao;

        linhasParaInserir.push([
          dataFormatada,
          iaResponse.categoria,
          desc,
          valorParcela,
          tipo,
        ]);
      }

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: "Página1!A:E",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: linhasParaInserir },
      });

      const respostaPlanilha = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: "Página1!A:E",
      });
      const linhas = respostaPlanilha.data.values || [];

      let faturaAtual = 0,
        faturaProxima = 0;

      for (let i = 1; i < linhas.length; i++) {
        if (!linhas[i][0] || !linhas[i][3]) continue;
        const partesData = linhas[i][0].split("/");
        const dGasto = new Date(
          partesData[2],
          partesData[1] - 1,
          partesData[0],
        );
        const val = converterValorSeguro(linhas[i][3]);

        if (dGasto >= inicioAtual && dGasto < fimAtual) faturaAtual += val;
        else if (dGasto >= inicioProximo && dGasto < fimProximo)
          faturaProxima += val;
      }

      let detalheParcelaMsg = isParcelado
        ? ` em ${parcelas}x de R$ ${valorParcela.toFixed(2).replace(".", ",")}`
        : ``;

      const mensagemFinal =
        `✅ **Gasto anotado para a próxima fatura!**\n\n` +
        `🏷 Categoria: ${iaResponse.categoria}\n` +
        `💸 Valor: R$ ${valorTotal.toFixed(2).replace(".", ",")}${detalheParcelaMsg}\n\n` +
        `🗓 **Fatura Atual (Vence este mês):** R$ ${faturaAtual.toFixed(2).replace(".", ",")}\n` +
        `📅 **Próxima Fatura (Mês que vem):** R$ ${faturaProxima.toFixed(2).replace(".", ",")}`;

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        mensagemFinal,
        { parse_mode: "Markdown" },
      );
    } else if (iaResponse.intencao === "consultar") {
      const respostaPlanilha = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: "Página1!A:E",
      });
      const linhas = respostaPlanilha.data.values || [];

      let total = 0;
      const categoriaBuscada = iaResponse.categoria;
      const isProximo = iaResponse.ciclo === "proximo";
      const alvoInicio = isProximo ? inicioProximo : inicioAtual;
      const alvoFim = isProximo ? fimProximo : fimAtual;

      for (let i = 1; i < linhas.length; i++) {
        if (!linhas[i][0] || !linhas[i][3]) continue;
        const partesData = linhas[i][0].split("/");
        const dataGasto = new Date(
          partesData[2],
          partesData[1] - 1,
          partesData[0],
        );
        const categoriaPlanilha = (linhas[i][1] || "").toLowerCase();

        if (dataGasto >= alvoInicio && dataGasto < alvoFim) {
          if (
            categoriaBuscada === "Todas" ||
            categoriaPlanilha === categoriaBuscada.toLowerCase()
          ) {
            total += converterValorSeguro(linhas[i][3]);
          }
        }
      }

      const rotuloCiclo = isProximo ? "Próxima fatura" : "Fatura atual";
      let msg =
        categoriaBuscada === "Todas"
          ? `📊 **${rotuloCiclo}:** R$ ${total.toFixed(2).replace(".", ",")}`
          : `🔎 Você tem **R$ ${total.toFixed(2).replace(".", ",")}** com *${categoriaBuscada}* na ${rotuloCiclo.toLowerCase()}.`;

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        msg,
        { parse_mode: "Markdown" },
      );
    }
  } catch (error) {
    console.error("Erro interno:", error);
    ctx.reply(
      "Tive um problema ao conectar com a planilha. Verifique se o formato do número está correto e tente novamente.",
    );
  }
});

bot.launch();
console.log("Bot conectado à Planilha e rodando!");

const app = express();
app.get("/", (req, res) => res.send("Bot Financeiro está online! 🚀"));
app.listen(process.env.PORT || 3000, () => console.log("Servidor Web ativo"));
