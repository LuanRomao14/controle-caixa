"use strict";

/* ==========================================================================
   Controle de Caixa — V4
   - Valores guardados em memória como CENTAVOS (inteiros).
   - No localStorage / backup os valores continuam em REAIS (compatível com
     os dados e backups da versão anterior).
   ========================================================================== */

const MESES = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const STORAGE_PREFIX = "fin_";
const META_BACKUP = "finmeta_ultimoBackup";
const CHAVE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_DIGITOS = 12;
const DIAS_ALERTA_BACKUP = 7;

const TIPOS = {
    entradas: "entradas",
    saidas: "saidas",
    investimentos: "investimentos",
};

const NOMES_TIPO = {
    entradas: "Entradas",
    saidas: "Saídas",
    investimentos: "Investimentos",
};

let mesChave = "";
let dadosEstado = null;
let cacheHistorico = {};
let graf = null;
let grafAnual = null;
let debounceTimer = null;
let storageDisponivel = true;
let falhaSalvarAvisada = false;
let avisoTimer = null;
let modalAcao = null;
let focoAntesModal = null;

document.addEventListener("DOMContentLoaded", iniciarAplicacao);

/* ---------- Inicialização ---------- */

function iniciarAplicacao() {
    storageDisponivel = testarStorage();
    carregarCacheDoStorage();

    const hoje = new Date();
    mesChave = criarChaveMes(hoje.getFullYear(), hoje.getMonth() + 1);
    carregarMes(mesChave);

    sincronizarSeletores();
    registrarEventosFixos();
    renderizarTudo();
    atualizarAvisoBackup();
}

function registrarEventosFixos() {
    document.getElementById("sel-ano").addEventListener("change", (event) => {
        const mes = Number(mesChave.slice(5, 7));
        irParaMes(criarChaveMes(Number(event.target.value), mes));
    });

    document.getElementById("sel-mes").addEventListener("change", (event) => {
        irParaMes(event.target.value);
    });

    document.querySelectorAll(".btn-add").forEach((btn) => {
        btn.addEventListener("click", () => adicionarItem(btn.dataset.tipo));
    });

    document.getElementById("btn-exportar").addEventListener("click", exportarBackup);
    document.getElementById("btn-importar").addEventListener("click", () => {
        document.getElementById("file-input").click();
    });
    document.getElementById("file-input").addEventListener("change", (event) => importarBackup(event.target));
    document.getElementById("btn-copiar").addEventListener("click", solicitarCopiaMesAnterior);

    document.getElementById("bloco-anual").addEventListener("toggle", atualizarAnual);

    document.getElementById("btn-cancelar-del").addEventListener("click", fecharModal);
    document.getElementById("btn-confirmar-del").addEventListener("click", confirmarModal);
    document.getElementById("modal-confirm").addEventListener("click", (event) => {
        if (event.target.id === "modal-confirm") fecharModal();
    });
    document.addEventListener("keydown", tratarTeclado);

    // Garante que um valor ainda no debounce seja salvo ao fechar/sair da aba.
    window.addEventListener("pagehide", descarregarPendente);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") descarregarPendente();
    });
}

function tratarTeclado(event) {
    const overlay = document.getElementById("modal-confirm");
    if (!overlay.classList.contains("active")) return;

    if (event.key === "Escape") {
        fecharModal();
        return;
    }

    if (event.key === "Tab") {
        const focaveis = [
            document.getElementById("btn-cancelar-del"),
            document.getElementById("btn-confirmar-del"),
        ];
        const primeiro = focaveis[0];
        const ultimo = focaveis[focaveis.length - 1];

        if (event.shiftKey && document.activeElement === primeiro) {
            event.preventDefault();
            ultimo.focus();
        } else if (!event.shiftKey && document.activeElement === ultimo) {
            event.preventDefault();
            primeiro.focus();
        } else if (!focaveis.includes(document.activeElement)) {
            event.preventDefault();
            primeiro.focus();
        }
    }
}

/* ---------- Datas e chaves ---------- */

function criarChaveMes(ano, mes) {
    return `${ano}-${String(mes).padStart(2, "0")}`;
}

function hojeISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nomeDoMes(chave) {
    const [ano, mes] = chave.split("-").map(Number);
    return `${MESES[mes - 1]} / ${ano}`;
}

/* ---------- Seletores de ano/mês ---------- */

function anosDisponiveis() {
    const hoje = new Date().getFullYear();
    const anos = new Set([hoje, hoje + 1, Number(mesChave.slice(0, 4))]);

    Object.keys(cacheHistorico).forEach((chave) => anos.add(Number(chave.slice(0, 4))));
    return [...anos].sort((a, b) => a - b);
}

function criarOption(value, texto, selected = false) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = texto;
    option.selected = selected;
    return option;
}

function sincronizarSeletores() {
    const ano = Number(mesChave.slice(0, 4));
    const selAno = document.getElementById("sel-ano");
    const selMes = document.getElementById("sel-mes");

    selAno.replaceChildren(...anosDisponiveis().map((a) => criarOption(a, String(a))));
    selAno.value = String(ano);

    selMes.replaceChildren(...MESES.map((nome, i) => criarOption(criarChaveMes(ano, i + 1), nome)));
    selMes.value = mesChave;
}

function irParaMes(chave) {
    if (!CHAVE_MES.test(chave)) return;

    descarregarPendente();
    mesChave = chave;
    carregarMes(mesChave);
    sincronizarSeletores();
    renderizarTudo();
}

/* ---------- Modelo de dados ---------- */

function criarMesPadrao() {
    return {
        entradas: [{ desc: "Minha Renda", valor: 0, fixa: false }],
        saidas: [{ desc: "Contas Fixas", valor: 0, fixa: true, pago: false }],
        investimentos: [],
    };
}

function novoItem(tipo) {
    const modelos = {
        entradas: { desc: "Nova Entrada", valor: 0, fixa: false },
        saidas: { desc: "Nova Conta", valor: 0, fixa: false, pago: false },
        investimentos: { desc: "Novo Aporte", valor: 0, tipo: "reserva" },
    };
    return modelos[tipo];
}

function paraCentavos(valorEmReais) {
    const n = Number(valorEmReais);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function paraReais(centavos) {
    return Math.round(centavos) / 100;
}

function normalizarMes(dados) {
    return {
        entradas: Array.isArray(dados?.entradas) ? dados.entradas.map(normalizarEntrada) : [],
        saidas: Array.isArray(dados?.saidas) ? dados.saidas.map(normalizarSaida) : [],
        investimentos: Array.isArray(dados?.investimentos) ? dados.investimentos.map(normalizarInvestimento) : [],
    };
}

function normalizarEntrada(item) {
    return {
        desc: String(item?.desc || ""),
        valor: paraCentavos(item?.valor),
        fixa: Boolean(item?.fixa),
    };
}

function normalizarSaida(item) {
    return {
        desc: String(item?.desc || ""),
        valor: paraCentavos(item?.valor),
        fixa: Boolean(item?.fixa),
        pago: Boolean(item?.pago),
    };
}

function normalizarInvestimento(item) {
    return {
        desc: String(item?.desc || ""),
        valor: paraCentavos(item?.valor),
        tipo: item?.tipo === "invest" ? "invest" : "reserva",
    };
}

function serializarMes(mes) {
    const comReais = (item) => ({ ...item, valor: paraReais(item.valor) });

    return {
        entradas: mes.entradas.map(comReais),
        saidas: mes.saidas.map(comReais),
        investimentos: mes.investimentos.map(comReais),
    };
}

/* ---------- Storage ---------- */

function testarStorage() {
    try {
        const chave = "__fin_teste__";
        localStorage.setItem(chave, "1");
        localStorage.removeItem(chave);
        return true;
    } catch {
        return false;
    }
}

function lerStorage(chave) {
    try {
        return localStorage.getItem(chave);
    } catch {
        return null;
    }
}

function carregarCacheDoStorage() {
    cacheHistorico = {};
    if (!storageDisponivel) return;

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const chaveCompleta = localStorage.key(i);
            if (!chaveCompleta || !chaveCompleta.startsWith(STORAGE_PREFIX)) continue;

            const chave = chaveCompleta.slice(STORAGE_PREFIX.length);
            if (!CHAVE_MES.test(chave)) continue;

            try {
                const bruto = localStorage.getItem(chaveCompleta);
                if (bruto) cacheHistorico[chave] = normalizarMes(JSON.parse(bruto));
            } catch {
                // mês corrompido: ignora e segue com os demais
            }
        }
    } catch {
        // storage inacessível
    }
}

function gravarMesNoStorage(chave, mes) {
    localStorage.setItem(`${STORAGE_PREFIX}${chave}`, JSON.stringify(serializarMes(mes)));
}

function salvarImediatamente() {
    clearTimeout(debounceTimer);
    debounceTimer = null;

    if (!dadosEstado || !mesChave) return;

    cacheHistorico[mesChave] = dadosEstado;

    if (!storageDisponivel) {
        avisarFalhaAoSalvar();
        return;
    }

    try {
        gravarMesNoStorage(mesChave, dadosEstado);
        falhaSalvarAvisada = false;
    } catch {
        avisarFalhaAoSalvar();
    }
}

function avisarFalhaAoSalvar() {
    if (falhaSalvarAvisada) return;
    falhaSalvarAvisada = true;
    mostrarAviso("Não foi possível salvar no navegador (armazenamento cheio ou bloqueado). Exporte um backup para não perder os dados.", "erro");
}

function agendarSalvar() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(salvarImediatamente, 300);
}

function descarregarPendente() {
    if (debounceTimer !== null) salvarImediatamente();
}

/* ---------- Carregar / derivar mês ---------- */

function chaveSalvaAnterior(chave) {
    const anteriores = Object.keys(cacheHistorico).filter((k) => k < chave).sort();
    return anteriores.length ? anteriores[anteriores.length - 1] : null;
}

// Só persiste quando o usuário editar algo: navegar entre meses não cria meses vazios.
function carregarMes(chave) {
    if (cacheHistorico[chave]) {
        dadosEstado = cacheHistorico[chave];
        return;
    }

    dadosEstado = criarMesDerivado(chave);
}

function criarMesDerivado(chave) {
    const anterior = chaveSalvaAnterior(chave);
    if (!anterior) return criarMesPadrao();

    const base = cacheHistorico[anterior];
    const entradas = base.entradas.filter((e) => e.fixa).map((e) => ({ ...e }));
    const saidas = base.saidas
        .map((s) => proximaSaida(s, false))
        .filter(Boolean);

    return {
        entradas: entradas.length ? entradas : [{ desc: "Minha Renda", valor: 0, fixa: false }],
        saidas,
        investimentos: [],
    };
}

// Só as saídas fixas seguem para o mês novo.
// copiarTudo = true (botão "Copiar mês anterior") leva também as contas avulsas.
function proximaSaida(saida, copiarTudo) {
    if (!saida.fixa && !copiarTudo) return null;

    return {
        desc: saida.desc || "Conta fixa",
        valor: saida.valor,
        fixa: saida.fixa,
        pago: false,
    };
}

function solicitarCopiaMesAnterior() {
    const anterior = chaveSalvaAnterior(mesChave);

    if (!anterior) {
        mostrarAviso("Não há mês anterior salvo para copiar.", "info");
        return;
    }

    abrirModal({
        titulo: "Copiar mês anterior",
        descricao: `Copiar entradas, saídas e investimentos de ${nomeDoMes(anterior)} para este mês? Itens com a mesma descrição que já existem aqui são ignorados.`,
        textoConfirmar: "Copiar",
        perigo: false,
        onConfirm: () => copiarMesAnterior(anterior),
    });
}

function copiarMesAnterior(chaveOrigem) {
    const origem = cacheHistorico[chaveOrigem];
    if (!origem) return;

    const jaExiste = (tipo, desc) =>
        dadosEstado[tipo].some((item) => item.desc.trim().toLowerCase() === desc.trim().toLowerCase());

    let copiados = 0;

    origem.entradas.forEach((e) => {
        if (jaExiste("entradas", e.desc)) return;
        dadosEstado.entradas.push({ ...e });
        copiados++;
    });

    origem.saidas.forEach((s) => {
        if (jaExiste("saidas", s.desc)) return;
        const nova = proximaSaida(s, true);
        if (!nova) return;
        dadosEstado.saidas.push(nova);
        copiados++;
    });

    origem.investimentos.forEach((inv) => {
        if (jaExiste("investimentos", inv.desc)) return;
        dadosEstado.investimentos.push({ ...inv });
        copiados++;
    });

    salvarImediatamente();
    renderizarTudo();
    mostrarAviso(copiados ? `${copiados} item(ns) copiado(s) de ${nomeDoMes(chaveOrigem)}.` : "Nada novo para copiar.", "info");
}

/* ---------- Edição de itens ---------- */

function adicionarItem(tipo) {
    if (!dadosEstado || !dadosEstado[tipo]) return;

    dadosEstado[tipo].push(novoItem(tipo));
    salvarImediatamente();
    renderizarTudo();

    const linhas = document.querySelectorAll(`#t-${tipo} tbody tr`);
    const ultimo = linhas[linhas.length - 1]?.querySelector(".txt-desc");
    if (ultimo) {
        ultimo.focus();
        ultimo.select();
    }
}

function solicitarExclusao(tipo, index) {
    const item = dadosEstado?.[tipo]?.[index];
    if (!item) return;

    const nome = item.desc ? `"${item.desc}"` : "este item";

    abrirModal({
        titulo: "Confirmar exclusão",
        descricao: `Excluir ${nome}? Esta ação não pode ser desfeita.`,
        textoConfirmar: "Excluir",
        perigo: true,
        onConfirm: () => {
            if (!dadosEstado?.[tipo]?.[index]) return;
            dadosEstado[tipo].splice(index, 1);
            salvarImediatamente();
            renderizarTudo();
            document.querySelector(`.btn-add[data-tipo="${tipo}"]`)?.focus();
        },
    });
}

/* ---------- Modal ---------- */

function abrirModal({ titulo, descricao, textoConfirmar = "Confirmar", perigo = true, onConfirm }) {
    const overlay = document.getElementById("modal-confirm");

    modalAcao = onConfirm;
    focoAntesModal = document.activeElement;

    document.getElementById("modal-title").textContent = titulo;
    document.getElementById("modal-desc").textContent = descricao;

    const btnConfirmar = document.getElementById("btn-confirmar-del");
    btnConfirmar.textContent = textoConfirmar;
    btnConfirmar.classList.toggle("neutro", !perigo);

    overlay.classList.add("active");
    overlay.setAttribute("aria-hidden", "false");
    document.getElementById("btn-cancelar-del").focus();
}

function fecharModal() {
    const overlay = document.getElementById("modal-confirm");

    overlay.classList.remove("active");
    overlay.setAttribute("aria-hidden", "true");
    modalAcao = null;

    if (focoAntesModal && typeof focoAntesModal.focus === "function" && document.contains(focoAntesModal)) {
        focoAntesModal.focus();
    }
    focoAntesModal = null;
}

function confirmarModal() {
    const acao = modalAcao;
    fecharModal();
    if (acao) acao();
}

/* ---------- Avisos ---------- */

function mostrarAviso(mensagem, tipo = "info") {
    const el = document.getElementById("aviso");
    if (!el) return;

    el.textContent = mensagem;
    el.className = `aviso aviso-${tipo} visivel`;

    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => el.classList.remove("visivel"), tipo === "erro" ? 8000 : 4000);
}

function atualizarAvisoBackup() {
    const el = document.getElementById("aviso-backup");
    if (!el) return;

    const temDados = Object.keys(cacheHistorico).length > 0;
    const ultimo = Number(lerStorage(META_BACKUP)) || 0;
    let texto = "";
    let alerta = false;

    if (!storageDisponivel) {
        texto = "Armazenamento do navegador indisponível (aba anônima ou bloqueado): os dados não serão salvos.";
        alerta = true;
    } else if (temDados && !ultimo) {
        texto = "Você ainda não exportou um backup.";
        alerta = true;
    } else if (ultimo) {
        const dias = Math.max(0, Math.floor((Date.now() - ultimo) / 86400000));
        texto = dias === 0 ? "Último backup: hoje" : dias === 1 ? "Último backup: ontem" : `Último backup: há ${dias} dias`;
        alerta = dias >= DIAS_ALERTA_BACKUP;
    }

    el.textContent = texto;
    el.classList.toggle("alerta", alerta);
}

/* ---------- Backup ---------- */

function exportarBackup() {
    descarregarPendente();

    const chaves = Object.keys(cacheHistorico).filter((k) => CHAVE_MES.test(k)).sort();
    if (!chaves.length) {
        mostrarAviso("Ainda não há dados salvos para exportar.", "info");
        return;
    }

    const exportData = {};
    chaves.forEach((chave) => {
        exportData[chave] = serializarMes(cacheHistorico[chave]);
    });

    baixarArquivoJson(exportData, `backup_financeiro_${hojeISO()}.json`);

    try {
        localStorage.setItem(META_BACKUP, String(Date.now()));
    } catch {
        // sem storage: só não registra a data
    }

    atualizarAvisoBackup();
    mostrarAviso(`Backup exportado (${chaves.length} mês(es)).`, "ok");
}

function importarBackup(input) {
    const arquivo = input.files?.[0];
    if (!arquivo) return;

    const reader = new FileReader();

    reader.onload = () => {
        try {
            const importData = JSON.parse(reader.result);
            validarBackup(importData);

            const chaves = Object.keys(importData);
            const sobrescreve = chaves.filter((k) => cacheHistorico[k]).length;

            abrirModal({
                titulo: "Importar backup",
                descricao: `O arquivo tem ${chaves.length} mês(es). ${sobrescreve
                    ? `${sobrescreve} deles já existem aqui e serão substituídos pelos do arquivo.`
                    : "Nenhum mês existente será substituído."} Deseja continuar?`,
                textoConfirmar: "Importar",
                perigo: sobrescreve > 0,
                onConfirm: () => aplicarImportacao(importData),
            });
        } catch {
            mostrarAviso("Arquivo de backup inválido.", "erro");
        } finally {
            input.value = "";
        }
    };

    reader.onerror = () => {
        mostrarAviso("Não foi possível ler o arquivo.", "erro");
        input.value = "";
    };

    reader.readAsText(arquivo);
}

function validarBackup(dados) {
    if (!dados || Array.isArray(dados) || typeof dados !== "object") {
        throw new Error("Backup inválido");
    }

    const chaves = Object.keys(dados);
    if (!chaves.length) throw new Error("Backup vazio");

    chaves.forEach((chave) => {
        if (!CHAVE_MES.test(chave)) throw new Error("Mês inválido");
        if (!dados[chave] || typeof dados[chave] !== "object" || Array.isArray(dados[chave])) {
            throw new Error("Dados do mês inválidos");
        }
    });
}

function aplicarImportacao(dados) {
    descarregarPendente();

    let falhas = 0;

    Object.keys(dados).forEach((chave) => {
        const mes = normalizarMes(dados[chave]);
        cacheHistorico[chave] = mes;

        if (!storageDisponivel) {
            falhas++;
            return;
        }

        try {
            gravarMesNoStorage(chave, mes);
        } catch {
            falhas++;
        }
    });

    carregarMes(mesChave);
    sincronizarSeletores();
    renderizarTudo();
    atualizarAvisoBackup();

    if (falhas) {
        mostrarAviso(`Backup importado, mas ${falhas} mês(es) não puderam ser gravados no navegador.`, "erro");
    } else {
        mostrarAviso("Backup restaurado com sucesso.", "ok");
    }
}

/* ---------- Download do backup (JSON) ---------- */

function baixarArquivoJson(conteudo, nomeArquivo) {
    baixarArquivo(JSON.stringify(conteudo, null, 2), nomeArquivo, "application/json;charset=utf-8");
}

function baixarArquivo(conteudo, nomeArquivo, tipo) {
    const blob = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = nomeArquivo;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Formatação ---------- */

function fmtReais(valorEmReais) {
    return Number(valorEmReais || 0).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
    });
}

function fmt(centavos) {
    return fmtReais(paraReais(centavos || 0));
}

function centavosDeTexto(texto) {
    const digitos = String(texto).replace(/\D/g, "").slice(0, MAX_DIGITOS);
    return digitos ? Number.parseInt(digitos, 10) : 0;
}

/* ---------- Cálculos (tudo em centavos) ---------- */

function somar(lista = []) {
    return lista.reduce((total, item) => total + (Number(item?.valor) || 0), 0);
}

function resumoMes(mes) {
    const entradas = somar(mes.entradas);
    const pagos = somar(mes.saidas.filter((s) => s.pago));
    const abertos = somar(mes.saidas.filter((s) => !s.pago));
    const reserva = somar(mes.investimentos.filter((i) => i.tipo === "reserva"));
    const investido = somar(mes.investimentos.filter((i) => i.tipo === "invest"));

    return {
        entradas,
        pagos,
        abertos,
        reserva,
        investido,
        saldoMes: entradas - pagos - reserva - investido,
    };
}

// Percorre todos os meses salvos (de todos os anos) em ordem e acumula.
// Regra do saldo: o resultado de cada mês (inclusive negativo) é levado ao seguinte.
function construirSerie() {
    const chaves = new Set(Object.keys(cacheHistorico));
    chaves.add(mesChave);

    const serie = new Map();
    let saldoAcumulado = 0;
    let reservaAcumulada = 0;
    let investidoAcumulado = 0;

    [...chaves].sort().forEach((chave) => {
        const mes = chave === mesChave ? dadosEstado : cacheHistorico[chave];
        const r = resumoMes(mes);

        r.saldoAnterior = saldoAcumulado;
        saldoAcumulado += r.saldoMes;
        reservaAcumulada += r.reserva;
        investidoAcumulado += r.investido;

        r.saldoAcumulado = saldoAcumulado;
        r.reservaAcumulada = reservaAcumulada;
        r.investidoAcumulado = investidoAcumulado;

        serie.set(chave, r);
    });

    return serie;
}

function calcularMetricasFinanceiras() {
    return construirSerie().get(mesChave);
}

/* ---------- Renderização ---------- */

function renderizarTudo() {
    renderizarTabelas();
    atualizarInterfaceMetricas();
}

function renderizarTabelas() {
    Object.values(TIPOS).forEach((tipo) => loopTab(tipo, dadosEstado[tipo]));
}

function loopTab(tipo, lista) {
    const tbody = document.querySelector(`#t-${tipo} tbody`);
    const fragment = document.createDocumentFragment();

    lista.forEach((item, index) => {
        fragment.appendChild(criarLinha(tipo, item, index));
    });

    tbody.replaceChildren(fragment);
}

function rotuloLinha(tipo, index) {
    return `${NOMES_TIPO[tipo]}, linha ${index + 1}`;
}

function criarLinha(tipo, item, index) {
    const tr = document.createElement("tr");
    const rotulo = rotuloLinha(tipo, index);

    tr.appendChild(criarCelulaInput({
        className: "txt-desc",
        value: item.desc,
        label: `Descrição (${rotulo})`,
        onEvento: (valor) => {
            item.desc = valor;
            agendarSalvar();
        },
    }));

    tr.appendChild(criarCelulaInput({
        className: "txt-val",
        value: fmt(item.valor),
        label: `Valor (${rotulo})`,
        attrs: { inputmode: "numeric", autocomplete: "off" },
        onEvento: (valor, input) => {
            const centavos = centavosDeTexto(valor);
            input.value = fmt(centavos);
            item.valor = centavos;
            atualizarInterfaceMetricas();
            agendarSalvar();
        },
    }));

    if (tipo === TIPOS.entradas) {
        tr.appendChild(criarCelulaCheckbox({
            className: "chk-fixa",
            texto: "Fixa",
            checked: item.fixa,
            label: `Entrada fixa (${rotulo})`,
            onChange: (checked) => {
                item.fixa = checked;
                salvarImediatamente();
            },
        }));
    }

    if (tipo === TIPOS.saidas) {
        tr.appendChild(criarCelulaCheckbox({
            className: "chk-fixa",
            texto: "Fixa",
            checked: item.fixa,
            label: `Conta fixa (${rotulo})`,
            onChange: (checked) => {
                item.fixa = checked;
                salvarImediatamente();
            },
        }));

        tr.appendChild(criarCelulaCheckbox({
            className: "chk-pago",
            texto: item.pago ? "Pago" : "Aberto",
            checked: item.pago,
            classeLabel: item.pago ? "c-pago" : "c-open",
            label: `Pago (${rotulo})`,
            onChange: (checked, td) => {
                item.pago = checked;

                const label = td.querySelector("label");
                label.lastChild.textContent = checked ? " Pago" : " Aberto";
                label.classList.toggle("c-pago", checked);
                label.classList.toggle("c-open", !checked);

                salvarImediatamente();
                atualizarInterfaceMetricas();
            },
        }));
    }

    if (tipo === TIPOS.investimentos) {
        tr.appendChild(criarCelulaTipoInvestimento(item.tipo, `Tipo (${rotulo})`, (valor) => {
            item.tipo = valor;
            salvarImediatamente();
            atualizarInterfaceMetricas();
        }));
    }

    tr.appendChild(criarCelulaExcluir(tipo, index, rotulo));
    return tr;
}

function criarCelulaInput({ type = "text", className, value, label, evento = "input", attrs = {}, onEvento }) {
    const td = document.createElement("td");
    const input = document.createElement("input");

    input.type = type;
    input.className = className;
    input.value = value;
    input.setAttribute("aria-label", label);
    Object.entries(attrs).forEach(([nome, valor]) => input.setAttribute(nome, valor));

    input.addEventListener(evento, () => onEvento(input.value, input));
    // Sem redesenhar a tabela: só garante que o que está pendente seja salvo.
    input.addEventListener("focusout", descarregarPendente);

    td.appendChild(input);
    return td;
}

function criarCelulaCheckbox({ className, texto, checked, label, classeLabel = "", onChange }) {
    const td = document.createElement("td");
    const rotulo = document.createElement("label");
    const input = document.createElement("input");

    td.className = "col-centro";
    rotulo.className = `chk-label ${classeLabel}`.trim();
    input.type = "checkbox";
    input.className = className;
    input.checked = Boolean(checked);
    input.setAttribute("aria-label", label);
    input.addEventListener("change", (event) => onChange(event.target.checked, td));

    rotulo.append(input, document.createTextNode(` ${texto}`));
    td.appendChild(rotulo);
    return td;
}

function criarCelulaTipoInvestimento(tipoAtual, label, onChange) {
    const td = document.createElement("td");
    const select = document.createElement("select");

    select.className = "sel-tipo";
    select.setAttribute("aria-label", label);
    select.append(
        criarOption("reserva", "Reserva", tipoAtual === "reserva"),
        criarOption("invest", "Investimento", tipoAtual === "invest"),
    );
    select.addEventListener("change", (event) => onChange(event.target.value));

    td.appendChild(select);
    return td;
}

function criarCelulaExcluir(tipo, index, rotulo) {
    const td = document.createElement("td");
    const btn = document.createElement("button");

    td.className = "col-acoes";
    btn.type = "button";
    btn.className = "btn-del";
    btn.textContent = "Excluir";
    btn.setAttribute("aria-label", `Excluir (${rotulo})`);
    btn.addEventListener("click", () => solicitarExclusao(tipo, index));

    td.appendChild(btn);
    return td;
}

function atualizarInterfaceMetricas() {
    const r = calcularMetricasFinanceiras();
    const saldoPrevisto = r.saldoAcumulado - r.abertos;

    definirTexto("res-entradas", fmt(r.entradas));
    definirTexto("res-pagos", fmt(r.pagos));
    definirTexto("res-pagos-sub", `Em aberto: ${fmt(r.abertos)}`);
    definirTexto("res-reserva", fmt(r.reservaAcumulada));
    definirTexto("res-reserva-sub", `No mês: ${fmt(r.reserva)}`);
    definirTexto("res-investido", fmt(r.investidoAcumulado));
    definirTexto("res-investido-sub", `No mês: ${fmt(r.investido)}`);

    definirSaldo("res-saldo-final", r.saldoAcumulado);
    definirTexto("res-saldo-sub", `Saldo dos meses anteriores: ${fmt(r.saldoAnterior)}`);

    definirSaldo("res-saldo-previsto", saldoPrevisto);
    definirTexto("res-previsto-sub", r.abertos > 0
        ? `Se as contas em aberto (${fmt(r.abertos)}) forem pagas`
        : "Todas as contas do mês estão pagas");

    atualizarGrafico(r);
    atualizarAnual();
}

function definirTexto(id, texto) {
    const el = document.getElementById(id);
    if (el) el.textContent = texto;
}

function definirSaldo(id, centavos) {
    const el = document.getElementById(id);
    el.textContent = fmt(centavos);
    el.style.color = centavos >= 0 ? "var(--green)" : "var(--red)";
}

function opcoesTooltipMoeda(formatador) {
    return { callbacks: { label: formatador } };
}

function atualizarGrafico(r) {
    const canvas = document.getElementById("grafico");
    const vazio = document.getElementById("grafico-vazio");
    const wrap = document.querySelector(".grafico-wrap");
    if (!canvas || !vazio || !wrap) return;

    if (typeof Chart === "undefined") {
        wrap.hidden = true;
        vazio.hidden = false;
        vazio.textContent = "Gráfico indisponível (não foi possível carregar a biblioteca).";
        return;
    }

    const valores = [r.pagos, r.abertos, r.reserva, r.investido].map(paraReais);
    const temValores = valores.some((valor) => valor > 0);

    wrap.hidden = !temValores;
    vazio.hidden = temValores;
    vazio.textContent = "Sem valores neste mês.";

    if (!temValores) {
        if (graf) {
            graf.destroy();
            graf = null;
        }
        return;
    }

    if (graf) {
        graf.data.datasets[0].data = valores;
        graf.update();
        return;
    }

    graf = new Chart(canvas.getContext("2d"), {
        type: "doughnut",
        data: {
            labels: ["Pago", "Aberto", "Reserva", "Investido"],
            datasets: [{
                data: valores,
                backgroundColor: ["#3b82f6", "#f59e0b", "#10b981", "#a855f7"],
                borderColor: "#151b2c",
                borderWidth: 2,
            }],
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    position: "bottom",
                    labels: { color: "#94a3b8", font: { size: 10 } },
                },
                tooltip: opcoesTooltipMoeda((ctx) => ` ${ctx.label}: ${fmtReais(ctx.parsed)}`),
            },
        },
    });
}

/* ---------- Visão anual ---------- */

function atualizarAnual() {
    const detalhes = document.getElementById("bloco-anual");
    if (!detalhes || !detalhes.open) return;

    const ano = Number(mesChave.slice(0, 4));
    const serie = construirSerie();
    const tbody = document.querySelector("#t-anual tbody");
    const tfoot = document.querySelector("#t-anual tfoot");
    const fragment = document.createDocumentFragment();

    const totais = { entradas: 0, pagos: 0, abertos: 0, reserva: 0, investido: 0, saldoMes: 0 };
    const grafEntradas = [];
    const grafSaidas = [];
    const grafGuardado = [];

    definirTexto("titulo-anual", `Visão anual — ${ano}`);

    MESES.forEach((nome, i) => {
        const chave = criarChaveMes(ano, i + 1);
        const r = serie.get(chave);
        const tr = document.createElement("tr");

        if (chave === mesChave) tr.classList.add("linha-atual");
        tr.appendChild(criarCelulaTexto(nome, false));

        if (!r) {
            for (let c = 0; c < 7; c++) tr.appendChild(criarCelulaTexto("—", true, "vazio"));
            grafEntradas.push(0);
            grafSaidas.push(0);
            grafGuardado.push(0);
        } else {
            [r.entradas, r.pagos, r.abertos, r.reserva, r.investido].forEach((v) => {
                tr.appendChild(criarCelulaTexto(fmt(v), true));
            });
            tr.appendChild(criarCelulaTexto(fmt(r.saldoMes), true, r.saldoMes < 0 ? "neg" : ""));
            tr.appendChild(criarCelulaTexto(fmt(r.saldoAcumulado), true, r.saldoAcumulado < 0 ? "neg" : ""));

            Object.keys(totais).forEach((k) => {
                totais[k] += r[k];
            });
            grafEntradas.push(paraReais(r.entradas));
            grafSaidas.push(paraReais(r.pagos + r.abertos));
            grafGuardado.push(paraReais(r.reserva + r.investido));
        }

        fragment.appendChild(tr);
    });

    tbody.replaceChildren(fragment);

    const trTotal = document.createElement("tr");
    trTotal.appendChild(criarCelulaTexto("Total do ano", false));
    [totais.entradas, totais.pagos, totais.abertos, totais.reserva, totais.investido, totais.saldoMes].forEach((v) => {
        trTotal.appendChild(criarCelulaTexto(fmt(v), true));
    });
    trTotal.appendChild(criarCelulaTexto("", true));
    tfoot.replaceChildren(trTotal);

    atualizarGraficoAnual(grafEntradas, grafSaidas, grafGuardado);
}

function criarCelulaTexto(texto, numerico, classe = "") {
    const td = document.createElement("td");
    td.textContent = texto;
    if (numerico) td.classList.add("num");
    if (classe) td.classList.add(classe);
    return td;
}

function atualizarGraficoAnual(entradas, saidas, guardado) {
    const canvas = document.getElementById("grafico-anual");
    if (!canvas || typeof Chart === "undefined") return;

    if (grafAnual) {
        grafAnual.data.datasets[0].data = entradas;
        grafAnual.data.datasets[1].data = saidas;
        grafAnual.data.datasets[2].data = guardado;
        grafAnual.update();
        return;
    }

    grafAnual = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels: MESES.map((m) => m.slice(0, 3)),
            datasets: [
                { label: "Entradas", data: entradas, backgroundColor: "#10b981" },
                { label: "Saídas", data: saidas, backgroundColor: "#f43f5e" },
                { label: "Reserva + Investido", data: guardado, backgroundColor: "#a855f7" },
            ],
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(36, 48, 79, 0.5)" } },
                y: {
                    beginAtZero: true,
                    ticks: { color: "#94a3b8", callback: (v) => fmtReais(v) },
                    grid: { color: "rgba(36, 48, 79, 0.5)" },
                },
            },
            plugins: {
                legend: { labels: { color: "#94a3b8", font: { size: 11 } } },
                tooltip: opcoesTooltipMoeda((ctx) => ` ${ctx.dataset.label}: ${fmtReais(ctx.parsed.y)}`),
            },
        },
    });
}

/* ---------- Compatibilidade com chamadas inline antigas ---------- */

window.exportarBackup = exportarBackup;
window.importarBackup = importarBackup;
