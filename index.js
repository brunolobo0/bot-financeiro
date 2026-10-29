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
Devolva ESTRITAMENTE um objeto JSON, sem nenhum texto fora dele.

Se a intenção for REGISTRAR, devolva o JSON neste formato:
{"intencao": "registrar", "categoria": "Eletrônicos", "valor_total": 300.00, "descricao": "Microondas", "parcelado": true, "qtd_parcelas": 3}
(Categorias válidas: Luz, Água, Combustível, Alimentação, Internet, Outros)

⚠️ REGRAS DE REGISTRO E PARCELAMENTO:
- Se houver divisão de conta (ex: "dividi com 1 amigo"), o "valor_total" deve ser APENAS a sua parte.
- Se for compra parcelada (ex: "comprei por 300 em 3x", "parcelado em 5 vezes"), marque "parcelado": true, extraia o número de vezes para "qtd_parcelas" e coloque o valor INTEGRAL no "valor_total".
- Se NÃO for parcelado, devolva "parcelado": false e "qtd_parcelas": 1.

Se a intenção for CONSULTAR:
{"intencao": "consultar", "categoria": "Alimentação"}
(Se perguntar o total geral, use a categoria "Todas").`;

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

// CORREÇÃO APLICADA AQUI: Calcula o fim do ciclo com base no início dele, não no dia atual
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

bot.start((ctx) => {
  if (String(ctx.from.id) !== String(process.env.MEU_ID_TELEGRAM)) {
    return ctx.reply("🔒 Acesso negado.");
  }
  ctx.reply("Olá! Mande seus gastos, sejam eles à vista ou parcelados.");
});

bot.on("text", async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.MEU_ID_TELEGRAM)) {
    return ctx.reply("🔒 Acesso negado.");
  }

  const userMessage = ctx.message.text;

  try {
    const loadingMsg = await ctx.reply("Calculando... 🤔");

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

    // CORREÇÃO APLICADA AQUI: Agora ele passa a variável certa
    const inicioDoCiclo = obterInicioDoCiclo(new Date());
    const fimDoCiclo = obterFimDoCiclo(inicioDoCiclo);

    // ==========================================
    // FLUXO A: REGISTRAR GASTO (Á VISTA OU PARCELADO)
    // ==========================================
    if (iaResponse.intencao === "registrar") {
      const isParcelado = iaResponse.parcelado;
      const parcelas = iaResponse.qtd_parcelas || 1;
      const valorTotal = iaResponse.valor_total;
      const valorParcela = valorTotal / parcelas;

      const linhasParaInserir = [];
      const hoje = new Date();

      for (let i = 0; i < parcelas; i++) {
        let dataGasto = new Date(
          hoje.getFullYear(),
          hoje.getMonth() + i,
          hoje.getDate(),
        );
        if (i > 0)
          dataGasto = new Date(hoje.getFullYear(), hoje.getMonth() + i, 10);

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

      let somaNormal = 0;
      let somaParcelado = 0;

      for (let i = 1; i < linhas.length; i++) {
        const linha = linhas[i];
        if (!linha[0] || !linha[3]) continue;

        const partesData = linha[0].split("/");
        const dGasto = new Date(
          partesData[2],
          partesData[1] - 1,
          partesData[0],
        );

        if (dGasto >= inicioDoCiclo && dGasto < fimDoCiclo) {
          // CORREÇÃO: Trata números grandes como 1.200,00 sem quebrar a soma
          const valLimpo = linha[3]
            .toString()
            .replace(/\./g, "")
            .replace(",", ".");
          const val = parseFloat(valLimpo);
          const tipoPlanilha = linha[4] || "Única";

          if (tipoPlanilha === "Parcelado") somaParcelado += val;
          else somaNormal += val;
        }
      }

      const total = somaNormal + somaParcelado;
      let detalheParcelaMsg = isParcelado
        ? ` em ${parcelas}x de R$ ${valorParcela.toFixed(2).replace(".", ",")}`
        : ``;

      const mensagemFinal =
        `✅ **Gasto anotado!**\n\n` +
        `🏷 Categoria: ${iaResponse.categoria}\n` +
        `📝 Descrição: ${iaResponse.descricao}\n` +
        `💸 Valor: R$ ${valorTotal.toFixed(2).replace(".", ",")}${detalheParcelaMsg}\n\n` +
        `📊 **Resumo deste mês:**\n` +
        `🔹 Gastos do mês: R$ ${somaNormal.toFixed(2).replace(".", ",")}\n` +
        `🔹 Parcelas: R$ ${somaParcelado.toFixed(2).replace(".", ",")}\n` +
        `**Total da Fatura: R$ ${total.toFixed(2).replace(".", ",")}**`;

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
      const respostaPlanilha = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: "Página1!A:E",
      });
      const linhas = respostaPlanilha.data.values || [];

      let somaNormal = 0;
      let somaParcelado = 0;
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

        if (dataGasto >= inicioDoCiclo && dataGasto < fimDoCiclo) {
          if (
            categoriaBuscada === "Todas" ||
            categoriaPlanilha === categoriaBuscada.toLowerCase()
          ) {
            // CORREÇÃO NUMÉRICA AQUI TAMBÉM
            const valLimpo = linha[3]
              .toString()
              .replace(/\./g, "")
              .replace(",", ".");
            const val = parseFloat(valLimpo);
            const tipoPlanilha = linha[4] || "Única";

            if (tipoPlanilha === "Parcelado") somaParcelado += val;
            else somaNormal += val;
          }
        }
      }

      const total = somaNormal + somaParcelado;
      let msg = "";

      if (categoriaBuscada === "Todas") {
        msg =
          `📊 **Resumo da sua fatura atual:**\n\n` +
          `🔹 Gastos do mês: R$ ${somaNormal.toFixed(2).replace(".", ",")}\n` +
          `🔹 Parcelas: R$ ${somaParcelado.toFixed(2).replace(".", ",")}\n` +
          `**Total: R$ ${total.toFixed(2).replace(".", ",")}**`;
      } else {
        msg =
          `🔎 Você gastou **R$ ${total.toFixed(2).replace(".", ",")}** com *${categoriaBuscada}* neste ciclo.\n\n` +
          `*(Sendo R$ ${somaNormal.toFixed(2).replace(".", ",")} do mês e R$ ${somaParcelado.toFixed(2).replace(".", ",")} em parcelas)*`;
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

const app = express();
app.get("/", (req, res) => {
  res.send("Bot Financeiro está online! 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Web rodando na porta ${PORT}`);
});
