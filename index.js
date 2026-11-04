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
{"intencao": "registrar", "categoria": "Outros", "valor_total": 637.00, "descricao": "Compra", "parcelado": true, "qtd_parcelas": 7}
(Categorias válidas: Luz, Água, Combustível, Alimentação, Internet, Outros)

⚠️ REGRAS MATEMÁTICAS (MUITO IMPORTANTE):
1. O "valor_total" DEVE ser o preço FINAL. Use apenas números e ponto (ex: 637.00). NUNCA inclua "R$".
2. SE O USUÁRIO INFORMAR O VALOR DA PARCELA (ex: "7 parcelas de 91"), VOCÊ DEVE MULTIPLICAR quantidade x parcela (7 * 91 = 637) e enviar o TOTAL no "valor_total".
3. Se houver divisão de conta, calcule SÓ a parte do usuário.

Se CONSULTAR, devolva:
{"intencao": "consultar", "categoria": "Alimentação"}
(Use categoria "Todas" se for uma pergunta geral)`;

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
  stringVal = stringVal.replace(/[^\d,\.-]/g, "");
  if (stringVal.includes(",")) {
    return parseFloat(stringVal.replace(/\./g, "").replace(",", ".")) || 0;
  } else {
    return parseFloat(stringVal) || 0;
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
  let loadingMsg;

  try {
    loadingMsg = await ctx.reply("Calculando... 🤔");

    // ATUALIZADO: Usando o modelo Gemini 3.8 Flash exigido pelo Google
    const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });
    const result = await model.generateContent(
      `${systemPrompt}\n\nUsuário: "${userMessage}"`,
    );
    const responseText = result.response
      .text()
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const iaResponse = JSON.parse(responseText);

    const inicioAtual = obterInicioDoCiclo(new Date());
    const fimAtual = obterFimDoCiclo(inicioAtual);
    const inicioProximo = fimAtual;
    const fimProximo = obterFimDoCiclo(inicioProximo);

    if (iaResponse.intencao === "registrar") {
      const isParcelado = iaResponse.parcelado;
      const parcelas = parseInt(iaResponse.qtd_parcelas) || 1;

      const valorTotal = converterValorSeguro(iaResponse.valor_total);

      if (valorTotal === 0 || isNaN(valorTotal)) {
        throw new Error(
          "O valor extraído da IA foi 0 ou não foi reconhecido como número.",
        );
      }

      const valorParcela = parseFloat((valorTotal / parcelas).toFixed(2));
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
        `📊 **Resumo Atualizado:**\n` +
        `🗓 **Fatura Atual:** R$ ${faturaAtual.toFixed(2).replace(".", ",")}\n` +
        `📅 **Próxima Fatura:** R$ ${faturaProxima.toFixed(2).replace(".", ",")}`;

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

      let totalAtual = 0;
      let totalProximo = 0;
      const categoriaBuscada = iaResponse.categoria;

      for (let i = 1; i < linhas.length; i++) {
        if (!linhas[i][0] || !linhas[i][3]) continue;
        const partesData = linhas[i][0].split("/");
        const dataGasto = new Date(
          partesData[2],
          partesData[1] - 1,
          partesData[0],
        );
        const categoriaPlanilha = (linhas[i][1] || "").toLowerCase();

        if (
          categoriaBuscada === "Todas" ||
          categoriaPlanilha === categoriaBuscada.toLowerCase()
        ) {
          const val = converterValorSeguro(linhas[i][3]);
          if (dataGasto >= inicioAtual && dataGasto < fimAtual)
            totalAtual += val;
          else if (dataGasto >= inicioProximo && dataGasto < fimProximo)
            totalProximo += val;
        }
      }

      let msg = "";
      if (categoriaBuscada === "Todas") {
        msg =
          `📊 **Resumo das suas Faturas:**\n\n` +
          `🗓 **Fatura Atual (Neste mês):** R$ ${totalAtual.toFixed(2).replace(".", ",")}\n` +
          `📅 **Próxima Fatura (Mês que vem):** R$ ${totalProximo.toFixed(2).replace(".", ",")}`;
      } else {
        msg =
          `🔎 Com *${categoriaBuscada}* você tem:\n\n` +
          `🗓 **Neste mês:** R$ ${totalAtual.toFixed(2).replace(".", ",")}\n` +
          `📅 **Mês que vem:** R$ ${totalProximo.toFixed(2).replace(".", ",")}`;
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
    console.error("Erro detalhado:", error);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        `🚨 Tive um problema técnico.\n\nMotivo: ${error.message}\n\nTente mandar a frase novamente.`,
      );
    } catch (e) {
      console.error("Erro crítico ao tentar avisar o usuário:", e);
    }
  }
});

bot.launch();
console.log("Bot atualizado para a versão 3.8 e rodando!");

const app = express();
app.get("/", (req, res) => res.send("Bot Financeiro está online! 🚀"));
app.listen(process.env.PORT || 3000, () => console.log("Servidor Web ativo"));
