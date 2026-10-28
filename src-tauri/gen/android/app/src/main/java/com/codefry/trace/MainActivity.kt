package com.codefry.trace

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

class AndroidShareBridge(private val context: Context) {

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun shareFile(filename: String, content: String, mimeType: String, title: String): Boolean {
        return try {
            val shareDir = File(context.cacheDir, "shared_telemetry")
            if (!shareDir.exists()) {
                shareDir.mkdirs()
            }
            val file = File(shareDir, filename)
            FileOutputStream(file).use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
            }

            val uri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )

            val mime = if (mimeType.isNotBlank()) mimeType else "*/*"
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, title)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            val chooser = Intent.createChooser(sendIntent, "Share Telemetry File").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    @JavascriptInterface
    fun shareText(text: String, title: String): Boolean {
        return try {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, text)
            }
            val chooser = Intent.createChooser(sendIntent, "Share Telemetry").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    @JavascriptInterface
    fun shareToApp(target: String, text: String, filename: String, content: String, mimeType: String): Boolean {
        return try {
            var uri: Uri? = null
            if (filename.isNotBlank() && content.isNotBlank()) {
                val shareDir = File(context.cacheDir, "shared_telemetry")
                if (!shareDir.exists()) shareDir.mkdirs()
                val file = File(shareDir, filename)
                FileOutputStream(file).use { it.write(content.toByteArray(Charsets.UTF_8)) }
                uri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    file
                )
            }

            val cleanTarget = target.trim().lowercase()
            when (cleanTarget) {
                "whatsapp" -> {
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        if (uri != null) {
                            type = if (mimeType.isNotBlank()) mimeType else "*/*"
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        } else {
                            type = "text/plain"
                        }
                        putExtra(Intent.EXTRA_TEXT, text)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }

                    try {
                        intent.setPackage("com.whatsapp")
                        context.startActivity(intent)
                        return true
                    } catch (e1: ActivityNotFoundException) {
                        try {
                            intent.setPackage("com.whatsapp.w4b")
                            context.startActivity(intent)
                            return true
                        } catch (e2: ActivityNotFoundException) {
                            val waUri = Uri.parse("whatsapp://send?text=" + Uri.encode(text))
                            val waIntent = Intent(Intent.ACTION_VIEW, waUri).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            context.startActivity(waIntent)
                            return true
                        }
                    }
                }
                "telegram" -> {
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        if (uri != null) {
                            type = if (mimeType.isNotBlank()) mimeType else "*/*"
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        } else {
                            type = "text/plain"
                        }
                        putExtra(Intent.EXTRA_TEXT, text)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }

                    try {
                        intent.setPackage("org.telegram.messenger")
                        context.startActivity(intent)
                        return true
                    } catch (e1: ActivityNotFoundException) {
                        val tgUri = Uri.parse("tg://msg?text=" + Uri.encode(text))
                        val tgIntent = Intent(Intent.ACTION_VIEW, tgUri).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        context.startActivity(tgIntent)
                        return true
                    }
                }
                "email" -> {
                    val emailIntent = Intent(Intent.ACTION_SEND).apply {
                        type = "message/rfc822"
                        putExtra(Intent.EXTRA_SUBJECT, "Trace Telemetry Export")
                        putExtra(Intent.EXTRA_TEXT, text)
                        if (uri != null) {
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    val chooser = Intent.createChooser(emailIntent, "Send Email").apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(chooser)
                    return true
                }
                else -> {
                    shareFile(filename, content, mimeType, text)
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }
}

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        webView.addJavascriptInterface(AndroidShareBridge(this), "AndroidShare")
    }
}
